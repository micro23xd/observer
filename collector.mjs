// collector.mjs — the observer service.
//
// Ingest (POST /events) ─► reduce (sync, in arrival order) ─► per-session state
//                                                │
//   ┌─ state.json  (atomic temp+rename, every ~15s + on signal)
//   ├─ events.jsonl (append-only durable log, rotated by size)
//   └─ in-memory buffers ◄─ rehydrated from events.jsonl on boot
//
// Read surface (Tier 0..3) for the oversight agent, bearer-gated:
//   /api/sessions  /api/digest  /api/session/:id  /api/session/:id/events
//   /api/session/:id/transcript (raw .jsonl)  /stream (SSE)  POST /mcp (MCP mirror)
// Write surface: /api/steer*, /api/control*, /api/ignore, /api/session/:id/summarize.
// Dashboard (GET /) is the only tokenless route; the server binds loopback by default and
// the dashboard's own data calls are bearer-gated like any other client.
//
// AUTH: the split is by ROUTE, never by source IP — `tailscale serve` (or any local
// reverse proxy) forwards remote requests to loopback, so remoteAddress is an unreliable
// signal. Every route except GET / — including POST /events and /mcp — requires
// Bearer $OBSERVER_TOKEN when it is set.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  normalizeHookEvent, reduce, newSession, sanitize,
  buildOverviewRow, buildDigestRow, buildDetail, parseSince, parseWorktreePath,
  BUFFER_CAP, DECISION_TOOLS,
} from "./core.mjs";
import { resolveRepoInfo } from "./gitinfo.mjs";
import { loadVertexConfig, createVertex } from "./vertex.mjs";
import { handleMcpMessage, TOOLS } from "./mcp.mjs";
import {
  selectDirective, renderResponse, initialStatus, isExpired, kindForHook,
  normalizeKind, normalizeMode, STATUS, STEER_KINDS, SESSION_MODES,
  DEFAULT_TTL_MS, DEFAULT_AUTO_KINDS,
  isTmuxDeliverable, renderTmuxText, promptIsEmpty, decideKeys, decisionPromptReady,
  GRANT_STATUS, DEFAULT_GRANT_TTL_MS, isGrantActive, isGrantPending,
} from "./steer.mjs";

const execFileP = promisify(execFile);

const PORT = parseInt(process.env.OBSERVER_PORT || "4000", 10);
// Bind loopback by default (defense-in-depth): `tailscale serve` reaches the collector
// over localhost, and local hooks post to localhost, so 127.0.0.1 exposes nothing to the
// LAN. Override with OBSERVER_HOST only if you know you need a wider bind.
const HOST = process.env.OBSERVER_HOST || "127.0.0.1";
const TOKEN = process.env.OBSERVER_TOKEN || null;
// Optional summary provider: Vertex AI, gated on a service-account key.
const VERTEX_CONFIG = loadVertexConfig();
const vertex = VERTEX_CONFIG ? createVertex(VERTEX_CONFIG) : null;
const DATA_DIR = process.env.OBSERVER_DATA_DIR || path.join(os.homedir(), ".observer");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
const IGNORE_FILE = path.join(DATA_DIR, "ignore.json");
const STEER_FILE = path.join(DATA_DIR, "steer.json");
const STEER_AUDIT_FILE = path.join(DATA_DIR, "steer.jsonl");
// The collector writes OBSERVER_TOKEN here (0600) so the local launch wrapper can authenticate
// its pane registration without the token being in the session's env. Local-only.
const TOKEN_FILE = path.join(DATA_DIR, "token");
const ROTATE_BYTES = parseInt(process.env.OBSERVER_ROTATE_BYTES || String(64 * 1024 * 1024), 10);
const ROTATE_KEEP = parseInt(process.env.OBSERVER_ROTATE_KEEP || "3", 10);
const PRUNE_MS = parseInt(process.env.OBSERVER_PRUNE_MS || String(7 * 24 * 3600 * 1000), 10);
const PERSIST_MS = 15_000;

const sessions = new Map(); // sessionId -> state
const sseClients = new Set(); // ServerResponse
let eventsStream = null; // append stream for events.jsonl

// Pane registry — cwd -> { server, target, ... }. The tmux launch wrapper
// (tmux/claude-steer.sh) runs claude inside a dedicated tmux server and POSTs its
// addressable target here before claude boots. We join it onto the session by cwd (the
// session's own SessionStart hook carries the same cwd), giving the collector a terminal
// to `send-keys` into when the session is idle and a hook can't reach it.
const panes = new Map(); // cwd -> { server, target, workspace?, terminalId?, ts }

// Repos/projects to hide from the discovery surfaces (list_sessions, digest).
// Lowercased; matched against repo basename and cwd substring. Seeded from
// OBSERVER_IGNORE, unioned with the persisted ignore.json, editable at runtime.
const ignored = new Set();

// Steering — bounded write-back into live sessions (see steer.mjs). Default-deny:
// nothing delivers unless the master switch is on AND the target session's mode is
// opted in. All knobs are dashboard-editable and persisted to steer.json; env vars
// are boot seeds only (runtime edits win), mirroring OBSERVER_IGNORE → ignore.json.
const steer = {
  master: false,                 // global kill switch
  defaultMode: "off",            // mode applied to sessions with no explicit setting
  ttlMs: DEFAULT_TTL_MS,         // directive expiry
  autoKinds: [...DEFAULT_AUTO_KINDS], // kinds that auto-arm in autonomous mode
  queueCap: 10,                  // max active (non-terminal) directives per session
  // Deliver nudge/context through the synchronous hook RESPONSE (the original channel)?
  // Default OFF: idle-pane (tmux send-keys) is the better path — it hands the agent a fresh
  // prompt instead of hijacking a Stop/UserPromptSubmit checkpoint. block_tool is exempt
  // (a real-time PreToolUse deny has no idle equivalent) and always uses its hook.
  hookSteering: false,
  modes: new Map(),              // sessionId -> "off" | "approval" | "autonomous"
  directives: new Map(),         // id -> directive
  seq: 0,                        // monotonic id counter (id = `d<seq>`)
  grants: new Map(),             // id -> control grant (request → grant → end); id = `g<seq>`
  grantSeq: 0,
};
let steerAuditStream = null;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function ensureDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

// Atomic write: write temp then rename over the target, so a crash never leaves a torn file.
async function writeJsonAtomic(file, obj) {
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(obj));
  await fsp.rename(tmp, file);
}

async function saveState() {
  const obj = {};
  for (const [id, s] of sessions) {
    // buffer persists via events.jsonl; tmux is ephemeral (a live target the wrapper
    // re-registers on launch) — persisting it would resurrect stale 🖥 after a restart.
    const { buffer, tmux, ...rest } = s;
    obj[id] = rest;
  }
  await writeJsonAtomic(STATE_FILE, obj);
}

async function loadState() {
  let raw;
  try { raw = await fsp.readFile(STATE_FILE, "utf8"); } catch { return; }
  let obj;
  try { obj = JSON.parse(raw); } catch { return; }
  for (const [id, rest] of Object.entries(obj)) {
    // Never trust a persisted tmux pane — it's runtime state the wrapper re-registers on
    // launch. A stale field (e.g. from a state.json written by an older build) would show a
    // 🖥 pointing at a dead target. Drop it; only a live registration sets it.
    const { tmux, ...clean } = rest;
    sessions.set(id, { ...newSession(id), ...clean, buffer: [] });
  }
}

// Rehydrate per-session ring buffers from events.jsonl on boot. Bounded by
// BUFFER_CAP per session, so memory stays flat regardless of log size.
async function rehydrateBuffers() {
  if (!fs.existsSync(EVENTS_FILE)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(EVENTS_FILE), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; } // skip corrupt lines (logged-by-omission)
    if (!e || !e.sessionId) continue;
    const s = sessions.get(e.sessionId);
    if (!s) continue; // only sessions present in state.json
    s.buffer.push(e);
    if (s.buffer.length > BUFFER_CAP) s.buffer.splice(0, s.buffer.length - BUFFER_CAP);
  }
}

async function rotateIfNeeded() {
  try {
    const st = await fsp.stat(EVENTS_FILE);
    if (st.size < ROTATE_BYTES) return;
  } catch { return; }
  if (eventsStream) { eventsStream.end(); eventsStream = null; }
  for (let i = ROTATE_KEEP - 1; i >= 1; i--) {
    const from = `${EVENTS_FILE}.${i}`, to = `${EVENTS_FILE}.${i + 1}`;
    if (fs.existsSync(from)) { try { await fsp.rename(from, to); } catch {} }
  }
  try { await fsp.rename(EVENTS_FILE, `${EVENTS_FILE}.1`); } catch {}
  openEventsStream();
}

function openEventsStream() {
  eventsStream = fs.createWriteStream(EVENTS_FILE, { flags: "a" });
  eventsStream.on("error", (e) => console.error("events.jsonl write error:", e.message));
}

function appendEvent(event) {
  if (!eventsStream) return;
  eventsStream.write(JSON.stringify(event) + "\n");
}

// ---------------------------------------------------------------------------
// Ingest — reduce SYNCHRONOUSLY in arrival order. Only the LLM fold defers.
// ---------------------------------------------------------------------------

// Fill the real repo name + branch from git when the hook can't. Worktree paths already
// carry both (core.parseWorktreePath handles them string-side, no I/O); only plain
// checkouts fall through to a cached .git read. Live-only — historical imports keep their
// transcript gitBranch and may not exist on disk.
function enrichGit(event) {
  if (!event.cwd || parseWorktreePath(event.cwd)) return event; // worktree → core handles it
  if (event.gitBranch && event.repoName) return event;
  const info = resolveRepoInfo(event.cwd); // cached; null if not a git checkout
  if (info) {
    if (!event.gitBranch && info.branch) event.gitBranch = info.branch;
    if (!event.repoName && info.repoName) event.repoName = info.repoName;
  }
  return event;
}

function ingestHook(payload) {
  const events = normalizeHookEvent(payload, Date.now());
  for (const raw of events) {
    if (!raw.sessionId) continue;
    const event = enrichGit(sanitize(raw));
    let s = sessions.get(event.sessionId);
    if (!s) { s = newSession(event.sessionId); sessions.set(event.sessionId, s); }
    reduce(s, event);
    joinPane(s); // attach a registered tmux target once we know this session's cwd
    appendEvent(event);
    broadcast(event);
    if (event.kind === "stop") {
      scheduleFold(s);          // side effect lives here, not in reduce()
      flushTmuxSteers(s);       // session just went idle → deliver any armed idle-directive
    }
    // A decision prompt (ExitPlanMode/AskUserQuestion) is a delivery checkpoint too — it
    // blocks for input, so a queued `decide` should land now rather than wait for idle.
    if (event.kind === "tool" && DECISION_TOOLS.has(event.tool)) flushTmuxSteers(s);
    if (event.kind === "session_end") {
      // The tmux target dies with the session — drop it so 🖥/steerable never lies, and free
      // the pane registry entry (a later session in the same cwd re-registers its own).
      s.tmux = undefined;
      if (s.cwd) panes.delete(s.cwd);
    }
  }
}

// Join a session to its tmux pane (by cwd). The wrapper's POST may land before or after
// the session's first hook, so both sides call this; latest registration wins.
function joinPane(s) {
  if (!s.cwd || s.status === "ended") return;
  const pane = panes.get(s.cwd);
  if (pane) claimPane(s, pane);
}

// A tmux target maps to exactly ONE live session. Give it to `s` and release it from any
// prior holder, so cwd collisions (sequential runs in the same checkout — common for plain
// checkouts like repo@main) don't light up multiple rows as steerable.
function claimPane(s, pane) {
  for (const other of sessions.values()) {
    if (other !== s && other.tmux && other.tmux.server === pane.server && other.tmux.target === pane.target) {
      other.tmux = undefined;
    }
  }
  s.tmux = { server: pane.server, target: pane.target };
}

// ---------------------------------------------------------------------------
// Rolling summary (optional, incremental) — fully non-blocking.
// ---------------------------------------------------------------------------

const folding = new Set();
function scheduleFold(s) {
  if (!vertex || folding.has(s.sessionId)) return;
  folding.add(s.sessionId);
  foldSummary(s).catch((e) => console.error("summary fold failed:", e.message)).finally(() => folding.delete(s.sessionId));
}

async function foldSummary(s) {
  const recent = s.buffer.slice(-80).map(renderEventLine).filter(Boolean).join("\n");
  const sys = "You summarize a coding session's activity in <=150 words: what was accomplished, key files, errors/blockers. Plain prose, no preamble.";
  const user = `${s.summary ? `Prior summary:\n${s.summary}\n\n` : ""}Recent activity:\n${recent}`;
  const text = await vertex.summarize(sys, user);
  if (text) { s.summary = text; s.summaryTs = Date.now(); }
}

function renderEventLine(e) {
  switch (e.kind) {
    case "prompt": return `> ${(e.prompt || "").slice(0, 200)}`;
    case "tool":
      if (e.input?.file_path) return `${e.tool} ${e.input.file_path}`;
      if (e.tool === "Bash" && e.input?.command) return `$ ${e.input.command.slice(0, 160)}`;
      return `tool ${e.tool}`;
    case "tool_result": return e.isError ? `! error` : null;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch { sseClients.delete(res); } }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function authed(req) {
  if (!TOKEN) return true; // dev mode: unset token allows all
  const got = Buffer.from(req.headers["authorization"] || "");
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return got.length === want.length && timingSafeEqual(got, want); // constant-time compare
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error("body too large"); chunks.push(c); }
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("request error:", e.message);
    try { if (!res.headersSent) sendJSON(res, 500, { error: "internal" }); else res.end(); } catch {}
  });
});

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch { return sendJSON(res, 400, { error: "bad url" }); }
  const p = url.pathname;

  // POST /events — hook ingest. Bearer-gated like every other write/read surface when
  // OBSERVER_TOKEN is set (local hooks send the same token via a `headers` field; see
  // README "Hook installation"). The "loopback-trusted" assumption is NOT safe by itself:
  // `tailscale serve` proxies tailnet peers to loopback, so an unauthenticated /events
  // would let any tailnet caller spoof hooks and consume/read steering directives. The
  // server also binds 127.0.0.1 (OBSERVER_HOST) so it is never LAN-exposed.
  //
  // The response body IS hook output to Claude Code (synchronous http hooks): if a
  // steering directive is deliverable for this session+hook we return its hook JSON,
  // otherwise the bare ack. computeSteer is wrapped so a steering bug can NEVER block a
  // session (falls back to ack).
  if (req.method === "POST" && p === "/events") {
    if (!authed(req)) return sendJSON(res, 401, { error: "unauthorized" });
    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 413, { error: "too large" }); }
    let payload = null;
    try { payload = JSON.parse(body); } catch { payload = null; }
    let steerResp = null;
    if (payload) { try { steerResp = computeSteer(payload); } catch (e) { console.error("steer error:", e.message); steerResp = null; } }
    sendJSON(res, 200, steerResp || { ok: true }); // steer JSON if any, else ack
    if (payload) { try { ingestHook(payload); } catch (e) { /* defensive: never throw out of ingest */ } }
    return;
  }

  // GET / — dashboard, tokenless (the page carries no data; its API calls are gated).
  if (req.method === "GET" && p === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(DASHBOARD_HTML);
  }

  // Everything below is the read surface — bearer-gated.
  if (!authed(req)) return sendJSON(res, 401, { error: "unauthorized" });

  // POST /mcp — remote MCP endpoint (Streamable HTTP, stateless JSON-RPC). Same
  // bearer gate as /api. Tools call the shared data-access helpers below.
  if (p === "/mcp") {
    if (req.method !== "POST") return sendJSON(res, 405, { error: "use POST for MCP" });
    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 413, { error: "too large" }); }
    let msg;
    try { msg = JSON.parse(body); } catch { return sendJSON(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    if (Array.isArray(msg)) { // tolerate JSON-RPC batches
      const out = [];
      for (const one of msg) { const r = await handleMcpMessage(one, mcpApi); if (r) out.push(r); }
      if (!out.length) { res.writeHead(202); return res.end(); }
      return sendJSON(res, 200, out);
    }
    const response = await handleMcpMessage(msg, mcpApi);
    if (response === null) { res.writeHead(202); return res.end(); } // notification
    return sendJSON(res, 200, response);
  }

  if (req.method === "GET" && p === "/api/sessions") {
    const activeOnly = ["1", "true", "yes"].includes((url.searchParams.get("active") || "").toLowerCase());
    return sendJSON(res, 200, apiSessions({ activeOnly }));
  }

  if (req.method === "GET" && p === "/api/digest") {
    return sendJSON(res, 200, await apiDigest(url.searchParams.get("since")));
  }

  // Ignore list management (dashboard + operator). Bearer-gated like the rest.
  if (p === "/api/ignore") {
    if (req.method === "GET") return sendJSON(res, 200, { ignore: [...ignored].sort() });
    if (req.method === "POST") {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: "bad json" }); }
      for (const e of (Array.isArray(body.add) ? body.add : [])) {
        const v = String(e).trim().toLowerCase();
        if (v) ignored.add(v);
      }
      for (const e of (Array.isArray(body.remove) ? body.remove : [])) {
        ignored.delete(String(e).trim().toLowerCase());
      }
      await saveIgnore();
      return sendJSON(res, 200, { ignore: [...ignored].sort() });
    }
    return sendJSON(res, 405, { error: "method not allowed" });
  }

  // Steering management (dashboard + operator + MCP write tools). Bearer-gated.
  if (p === "/api/steer") {
    if (req.method === "GET") return sendJSON(res, 200, steerSnapshot());
    if (req.method === "POST") {
      let b; try { b = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: "bad json" }); }
      try {
        const d = steerCreate({
          sessionId: b.sessionId || b.session_id, kind: b.kind, text: b.text,
          // Audit attribution reflects the auth channel, never the request body — the REST
          // surface is the operator's (bearer-gated). Ignoring client `by` keeps steer.jsonl
          // attribution unforgeable (MCP hardcodes "agent" for the same reason).
          toolMatch: b.toolMatch || b.tool_match, ttlMs: b.ttlMs || b.ttl_ms, by: "operator",
        });
        return sendJSON(res, 200, d);
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    return sendJSON(res, 405, { error: "method not allowed" });
  }
  // Pane registration — the tmux launch wrapper POSTs its tmux target here so the
  // collector can send-keys into the session while it's idle. Bearer-gated like the rest;
  // the wrapper forwards OBSERVER_TOKEN. Joined to sessions by cwd.
  if (req.method === "POST" && p === "/api/steer/pane") {
    let b; try { b = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: "bad json" }); }
    const cwd = b.cwd ? String(b.cwd) : "";
    const target = b.target ? String(b.target) : "";
    if (!cwd || !target) return sendJSON(res, 400, { error: "missing cwd/target" });
    const pane = {
      server: b.server ? String(b.server) : "observer", target,
      workspace: b.workspace ? String(b.workspace) : undefined,
      terminalId: b.terminalId ? String(b.terminalId) : undefined,
      ts: Date.now(),
    };
    panes.set(cwd, pane);
    // Attach to the most-recently-active live session in this cwd (the POST may arrive after
    // the session's first hook). One session owns the pane; later hooks from the genuinely
    // active session keep it via joinPane. Never attach to an ended session.
    let best = null;
    for (const s of sessions.values()) {
      if (s.cwd !== cwd || s.status === "ended") continue;
      if (!best || (s.lastTs || 0) > (best.lastTs || 0)) best = s;
    }
    if (best) claimPane(best, pane);
    return sendJSON(res, 200, { ok: true, cwd, target: pane.target, server: pane.server, attached: best ? best.sessionId : null });
  }
  if (req.method === "POST" && p === "/api/steer/master") {
    let b; try { b = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: "bad json" }); }
    return sendJSON(res, 200, { master: steerSetMaster(b.enabled) });
  }
  if (req.method === "POST" && p === "/api/steer/mode") {
    let b; try { b = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: "bad json" }); }
    try { const mode = steerSetMode(b.sessionId || b.session_id, b.mode); return sendJSON(res, 200, { sessionId: b.sessionId || b.session_id, mode }); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }
  if (req.method === "POST" && p === "/api/steer/config") {
    let b; try { b = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: "bad json" }); }
    try { return sendJSON(res, 200, steerSetConfig(b)); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }
  const sm = p.match(/^\/api\/steer\/([^/]+)\/(approve|cancel)$/);
  if (req.method === "POST" && sm) {
    const id = decodeURIComponent(sm[1]);
    const d = sm[2] === "approve" ? steerApprove(id, "operator") : steerCancel(id, "operator");
    if (!d) return sendJSON(res, 404, { error: "no such directive" });
    return sendJSON(res, 200, d);
  }

  // ── Control grants — OPERATOR ONLY (this surface is never exposed over MCP). ──
  // grant/deny an agent request, or revoke an active grant. The consent boundary lives here.
  if (p === "/api/control") {
    if (req.method === "GET") { const { grants, pendingControl } = steerSnapshot(); return sendJSON(res, 200, { grants, pendingControl }); }
    // POST /api/control — operator-initiated request (then immediately grantable below).
    if (req.method === "POST") {
      let b; try { b = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: "bad json" }); }
      try {
        const g = controlRequest({ sessionId: b.sessionId || b.session_id, task: b.task, ttlMs: b.ttlMs || b.ttl_ms, by: "operator" });
        return sendJSON(res, 200, g);
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    return sendJSON(res, 405, { error: "method not allowed" });
  }
  const cm = p.match(/^\/api\/control\/([^/]+)\/(grant|deny|revoke)$/);
  if (req.method === "POST" && cm) {
    const id = decodeURIComponent(cm[1]);
    let b = {}; try { b = JSON.parse(await readBody(req)); } catch { /* body optional */ }
    let g;
    if (cm[2] === "grant") g = controlGrant(id, "operator", b.ttlMs || b.ttl_ms);
    else if (cm[2] === "deny") g = controlDeny(id, "operator");
    else g = controlEnd(id, "operator", "revoked");
    if (!g) return sendJSON(res, 404, { error: "no such control grant" });
    return sendJSON(res, 200, g);
  }

  let m = p.match(/^\/api\/session\/([^/]+)(\/events|\/transcript)?$/);
  if (req.method === "GET" && m) {
    const id = decodeURIComponent(m[1]);
    const s = sessions.get(id);
    if (!s) return sendJSON(res, 404, { error: "no such session" });

    if (m[2] === "/events") { // Tier 2 drill-down
      return sendJSON(res, 200, apiSessionEvents(id, url.searchParams.get("types"), url.searchParams.get("limit")));
    }

    if (m[2] === "/transcript") { // Tier 3 raw .jsonl — streamed for REST
      if (!s.transcriptPath || !fs.existsSync(s.transcriptPath)) {
        return sendJSON(res, 404, { error: "no transcript on disk" });
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      fs.createReadStream(s.transcriptPath).on("error", () => res.end()).pipe(res);
      return;
    }

    return sendJSON(res, 200, apiSession(id)); // Tier 1 detail (+ control summary)
  }

  if (req.method === "POST" && (m = p.match(/^\/api\/session\/([^/]+)\/summarize$/))) {
    const s = sessions.get(decodeURIComponent(m[1]));
    if (!s) return sendJSON(res, 404, { error: "no such session" });
    if (!vertex) return sendJSON(res, 200, { summary: s.summary });
    try { await foldSummary(s); } catch (e) { return sendJSON(res, 502, { error: e.message }); }
    return sendJSON(res, 200, { summary: s.summary });
  }

  if (req.method === "GET" && p === "/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  return sendJSON(res, 404, { error: "not found" });
}

// Digest window source: use the in-memory buffer when it fully covers the
// window; otherwise scan events.jsonl so long windows aren't truncated by the cap.
async function windowEvents(s, cutoff) {
  const buf = s.buffer.filter((e) => e.ts >= cutoff);
  const bufferCoversWindow = s.buffer.length < BUFFER_CAP || (s.buffer[0] && s.buffer[0].ts <= cutoff);
  if (bufferCoversWindow) return buf;
  return scanLog(s.sessionId, cutoff);
}

async function scanLog(sessionId, cutoff) {
  const out = [];
  const files = [EVENTS_FILE, ...Array.from({ length: ROTATE_KEEP }, (_, i) => `${EVENTS_FILE}.${i + 1}`)];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e && e.sessionId === sessionId && e.ts >= cutoff) out.push(e);
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// ---------------------------------------------------------------------------
// Ignore list — hide repos/projects from discovery (apiSessions/apiDigest).
// ---------------------------------------------------------------------------

function seedIgnore() {
  // Persisted runtime edits.
  try {
    const arr = JSON.parse(fs.readFileSync(IGNORE_FILE, "utf8"));
    if (Array.isArray(arr)) for (const e of arr) ignored.add(String(e).toLowerCase());
  } catch { /* none yet */ }
  // Env seed — always applied on boot.
  for (const e of (process.env.OBSERVER_IGNORE || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    ignored.add(e);
  }
}

async function saveIgnore() {
  await writeJsonAtomic(IGNORE_FILE, [...ignored].sort());
}

function matchesIgnore(repo, cwd) {
  if (!ignored.size) return false;
  const repoName = (repo || "").split("@")[0].toLowerCase();
  const cwdL = (cwd || "").toLowerCase();
  for (const e of ignored) {
    if (repoName === e || (cwdL && cwdL.includes(e))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Steering — bounded write-back. The store + side effects; the decision logic
// (gating/match/render) lives in steer.mjs and is unit-tested there.
// ---------------------------------------------------------------------------

function openSteerAudit() {
  steerAuditStream = fs.createWriteStream(STEER_AUDIT_FILE, { flags: "a" });
  steerAuditStream.on("error", (e) => console.error("steer.jsonl write error:", e.message));
}

// Append-only audit of every steering transition (create/arm/deliver/expire/cancel/
// mode/master/config). The permanent record — directives are pruned from memory, this
// is not. No redaction (project ethos): full directive text is logged.
function steerAudit(entry) {
  if (!steerAuditStream) return;
  try { steerAuditStream.write(JSON.stringify({ ts: Date.now(), ...entry }) + "\n"); } catch {}
}

// Boot: defaults (in the `steer` literal) → env seeds → persisted overlay (authoritative,
// so dashboard edits win and survive restart) → expire anything already past TTL.
function seedSteer() {
  const envMaster = (process.env.OBSERVER_STEERING || "").toLowerCase();
  if (envMaster) steer.master = ["on", "1", "true", "yes"].includes(envMaster);
  const envMode = normalizeMode(process.env.OBSERVER_STEER_DEFAULT_MODE);
  if (envMode) steer.defaultMode = envMode;
  const envTtl = parseInt(process.env.OBSERVER_STEER_TTL_MS || "", 10);
  if (Number.isFinite(envTtl) && envTtl > 0) steer.ttlMs = envTtl;
  const envKinds = (process.env.OBSERVER_STEER_AUTO_KINDS || "").split(",").map((s) => s.trim())
    .filter((k) => STEER_KINDS.includes(k) && k !== "block_tool");
  if (envKinds.length) steer.autoKinds = envKinds;
  const envHook = (process.env.OBSERVER_HOOK_STEERING || "").toLowerCase();
  if (envHook) steer.hookSteering = ["on", "1", "true", "yes"].includes(envHook);

  try {
    const obj = JSON.parse(fs.readFileSync(STEER_FILE, "utf8"));
    if (obj && typeof obj === "object") {
      if (typeof obj.master === "boolean") steer.master = obj.master;
      if (normalizeMode(obj.defaultMode)) steer.defaultMode = obj.defaultMode;
      if (Number.isFinite(obj.ttlMs) && obj.ttlMs > 0) steer.ttlMs = obj.ttlMs;
      if (Array.isArray(obj.autoKinds)) steer.autoKinds = obj.autoKinds.filter((k) => STEER_KINDS.includes(k) && k !== "block_tool");
      if (typeof obj.hookSteering === "boolean") steer.hookSteering = obj.hookSteering;
      if (Number.isFinite(obj.queueCap) && obj.queueCap > 0) steer.queueCap = obj.queueCap;
      if (Number.isFinite(obj.seq)) steer.seq = obj.seq;
      if (obj.modes && typeof obj.modes === "object") {
        for (const [k, v] of Object.entries(obj.modes)) if (normalizeMode(v)) steer.modes.set(k, v);
      }
      if (Array.isArray(obj.directives)) for (const d of obj.directives) if (d && d.id) steer.directives.set(d.id, d);
      if (Number.isFinite(obj.grantSeq)) steer.grantSeq = obj.grantSeq;
      if (Array.isArray(obj.grants)) for (const g of obj.grants) if (g && g.id) steer.grants.set(g.id, g);
    }
  } catch { /* none yet */ }
  sweepSteer(Date.now());
}

async function saveSteer() {
  const obj = {
    master: steer.master, defaultMode: steer.defaultMode, ttlMs: steer.ttlMs,
    autoKinds: steer.autoKinds, hookSteering: steer.hookSteering, queueCap: steer.queueCap, seq: steer.seq,
    modes: Object.fromEntries(steer.modes),
    directives: [...steer.directives.values()],
    grants: [...steer.grants.values()], grantSeq: steer.grantSeq,
  };
  await writeJsonAtomic(STEER_FILE, obj);
}

function sessionMode(sid) { return steer.modes.get(sid) || steer.defaultMode; }

// Control-grant lookups. At most one active and one pending grant per session matter.
function activeGrantFor(sid) {
  const now = Date.now();
  for (const g of steer.grants.values()) if (g.sessionId === sid && isGrantActive(g, now)) return g;
  return null;
}
function pendingGrantFor(sid) {
  for (const g of steer.grants.values()) if (g.sessionId === sid && isGrantPending(g)) return g;
  return null;
}
// Effective mode = an active control grant elevates the session to "autonomous" for its
// scope (the explicit, time-boxed consent); otherwise the operator-set mode applies. Every
// delivery decision routes through this so a grant and a static mode share one code path.
function effectiveMode(sid) {
  return activeGrantFor(sid) ? "autonomous" : sessionMode(sid);
}
function directivesFor(sid) {
  const out = [];
  for (const d of steer.directives.values()) if (d.sessionId === sid) out.push(d);
  return out;
}
function activeCount(sid) {
  let n = 0;
  for (const d of steer.directives.values()) {
    if (d.sessionId === sid && (d.status === STATUS.PROPOSED || d.status === STATUS.ARMED)) n++;
  }
  return n;
}

// computeSteer — called synchronously from POST /events. Returns hook-output JSON for the
// one deliverable directive (consuming it, one-shot), or null for the bare ack. Throwing
// is impossible-by-contract (handler wraps it), but we keep it defensive regardless.
function computeSteer(payload) {
  if (!steer.master) return null;
  const sid = payload && payload.session_id;
  if (!sid) return null;
  const mode = effectiveMode(sid); // an active control grant counts as autonomous here
  if (mode === "off") return null;
  const kind = kindForHook(payload.hook_event_name);
  if (!kind) return null;
  // Hook delivery of the soft levers (nudge/context) is opt-in (default off) — they prefer
  // the idle-pane path. block_tool always uses its hook: a PreToolUse deny has no idle
  // equivalent, so gating it would silently disable the only real-time guardrail.
  if (kind !== "block_tool" && !steer.hookSteering) return null;
  const now = Date.now();
  const d = selectDirective(payload, directivesFor(sid), { masterOn: true, mode, now });
  if (!d) return null;
  // One-shot consume — synchronous, so two near-simultaneous hooks can't both take it.
  d.status = STATUS.DELIVERED;
  d.deliveredTs = now;
  d.deliveredVia = payload.hook_event_name;
  steerAudit({ ev: "deliver", id: d.id, sessionId: sid, kind: d.kind, via: d.deliveredVia, text: d.text });
  saveSteer().catch(() => {});
  return renderResponse(d);
}

// ── Idle delivery via tmux send-keys ──
// The collector's second delivery channel: when a hook can't reach a session because it's
// idle, type the directive into its terminal. Strictly additive — computeSteer still owns
// the in-turn hook path for active sessions; this only fires for status "idle", or while a
// decision prompt (plan approval / question) is pending and a `decide` can answer it. Best-effort
// throughout: any failure leaves the directive ARMED (a later hook can still deliver it) and
// never throws into the ingest path.

const flushing = new Set(); // sessionId guard — one in-flight flush per session

async function capturePane(server, target) {
  return (await execFileP("tmux", ["-L", server, "capture-pane", "-p", "-t", target], { timeout: 2000 })).stdout;
}

// Deliver one armed directive into a session's terminal. Two modes:
//   • decide      → answer the live decision prompt (poll until it's painted, then type the
//                   mapped keys). Only when the session is awaiting that decision.
//   • context/nudge → type a free message at an idle ❯ prompt (never into a menu).
// Returns true on delivery. Best-effort: a dead target self-clears; never throws.
async function deliverViaTmux(s, d) {
  if (!s || !s.tmux || !isTmuxDeliverable(d.kind)) return false;
  const { server, target } = s.tmux;
  const decision = s.awaitingDecision || false;

  if (d.kind === "decide") {
    if (!decision) return false; // a decide answer only makes sense at a decision prompt
    // PreToolUse fires before the prompt paints — wait briefly for it.
    let pane = null;
    for (let i = 0; i < 6; i++) {
      try { pane = await capturePane(server, target); } catch { s.tmux = undefined; return false; }
      if (decisionPromptReady(pane)) break;
      pane = null;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (pane === null) return false; // prompt never rendered — leave armed, retry next checkpoint
    const keys = decideKeys(d.text, decision, s.decisionOptions || []);
    if (!await sendKeys(s, server, target, keys)) return false;
  } else {
    if (decision || s.status !== "idle") return false; // free text only at an idle prompt
    let pane;
    try { pane = await capturePane(server, target); } catch { s.tmux = undefined; return false; }
    if (!promptIsEmpty(pane)) return false; // don't clobber half-typed input
    if (!await sendKeys(s, server, target, renderTmuxText(d))) return false;
  }

  d.status = STATUS.DELIVERED; d.deliveredTs = Date.now(); d.deliveredVia = "tmux";
  steerAudit({ ev: "deliver", id: d.id, sessionId: s.sessionId, kind: d.kind, via: "tmux", text: d.text });
  saveSteer().catch(() => {});
  return true;
}

// Type literal text + Enter into a pane. Returns false (and forgets a dead target) on failure.
async function sendKeys(s, server, target, text) {
  try {
    await execFileP("tmux", ["-L", server, "send-keys", "-t", target, "-l", text], { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 120)); // let the TUI register the paste before Enter
    await execFileP("tmux", ["-L", server, "send-keys", "-t", target, "Enter"], { timeout: 2000 });
    return true;
  } catch { s.tmux = undefined; return false; }
}

// Flush one armed directive that fits the session's current state (FIFO, one per checkpoint).
// State-aware eligibility: while awaiting a decision only `decide` is eligible (never type a
// free message into a menu); at an idle prompt only context/nudge. Gated default-deny.
async function flushTmuxSteers(s) {
  if (!steer.master || !s || !s.tmux) return;
  if (!(s.status === "idle" || s.awaitingDecision)) return;
  if (effectiveMode(s.sessionId) === "off") return;
  if (flushing.has(s.sessionId)) return;
  flushing.add(s.sessionId);
  try {
    const now = Date.now();
    const eligible = s.awaitingDecision ? (k) => k === "decide" : (k) => k === "context" || k === "nudge";
    const armed = directivesFor(s.sessionId)
      .filter((d) => d.status === STATUS.ARMED && eligible(d.kind) && !isExpired(d, now))
      .sort((a, b) => (a.createdTs || 0) - (b.createdTs || 0));
    for (const d of armed) {
      if (await deliverViaTmux(s, d)) break;
    }
  } catch (e) {
    console.error("tmux flush error:", e.message);
  } finally {
    flushing.delete(s.sessionId);
  }
}

// Fire-and-forget trigger used by the mutation paths (create/approve): if the target
// session is idle with a pane, try to deliver now instead of waiting for its next hook.
function maybeTmuxDeliver(sid) {
  const s = sessions.get(sid);
  if (s) flushTmuxSteers(s).catch(() => {});
}

// ── Mutations (REST + MCP write tools route here) ──

function steerCreate({ sessionId, kind, text, toolMatch, ttlMs, by }) {
  if (!steer.master) throw new Error("steering is disabled (master switch is off)");
  if (!sessionId) throw new Error("missing session_id");
  const k = normalizeKind(kind);
  if (!k) throw new Error(`invalid kind: ${kind} (use ${STEER_KINDS.join("|")})`);
  const mode = effectiveMode(sessionId); // an active control grant makes an off session steerable
  if (mode === "off") throw new Error(`session ${sessionId} is not steerable — set its mode to approval/autonomous, or request control first`);
  const t = String(text || "").trim();
  if (!t) throw new Error("missing text");
  if (activeCount(sessionId) >= steer.queueCap) throw new Error(`steer queue full for session ${sessionId} (cap ${steer.queueCap})`);
  const now = Date.now();
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : steer.ttlMs;
  const id = `d${++steer.seq}`;
  const d = {
    id, sessionId, kind: k, text: t,
    toolMatch: k === "block_tool" && toolMatch ? String(toolMatch) : undefined,
    status: initialStatus(k, mode, steer.autoKinds),
    createdTs: now, createdBy: by || "operator",
    expiresTs: now + ttl,
    deliveredTs: undefined, deliveredVia: undefined,
  };
  steer.directives.set(id, d);
  steerAudit({ ev: "create", id, sessionId, kind: k, status: d.status, by: d.createdBy, text: t, toolMatch: d.toolMatch });
  saveSteer().catch(() => {});
  if (d.status === STATUS.ARMED) maybeTmuxDeliver(sessionId); // auto-armed + idle → deliver now
  return d;
}

function steerApprove(id, by) {
  const d = steer.directives.get(id);
  if (!d) return null;
  if (d.status === STATUS.PROPOSED) {
    d.status = STATUS.ARMED;
    steerAudit({ ev: "arm", id, sessionId: d.sessionId, kind: d.kind, by: by || "operator" });
    saveSteer().catch(() => {});
    maybeTmuxDeliver(d.sessionId); // just armed by operator approval → deliver if idle
  }
  return d;
}

function steerCancel(id, by) {
  const d = steer.directives.get(id);
  if (!d) return null;
  if (d.status === STATUS.PROPOSED || d.status === STATUS.ARMED) {
    d.status = STATUS.CANCELLED;
    d.cancelledTs = Date.now();
    steerAudit({ ev: "cancel", id, sessionId: d.sessionId, kind: d.kind, by: by || "operator" });
    saveSteer().catch(() => {});
  }
  return d;
}

// ── Control grants — request (agent/MCP) → grant/deny/revoke (operator only) → release ──
// The grant transition lives ONLY here and is reached only from the operator's REST surface
// (dashboard); there is deliberately no MCP grant tool, so the agent can request and release
// but can never grant itself control.

function controlRequest({ sessionId, task, ttlMs, by }) {
  if (!steer.master) throw new Error("steering is disabled (master switch is off)");
  if (!sessionId) throw new Error("missing session_id");
  const active = activeGrantFor(sessionId);
  if (active) return active;            // already in control — idempotent
  const pending = pendingGrantFor(sessionId);
  if (pending) return pending;          // already awaiting your yes — don't stack requests
  const t = String(task || "").trim();
  if (!t) throw new Error("missing task (describe what you want to take over)");
  const now = Date.now();
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_GRANT_TTL_MS;
  const id = `g${++steer.grantSeq}`;
  const g = {
    id, sessionId, task: t, status: GRANT_STATUS.REQUESTED,
    requestedBy: by || "agent", requestedTs: now, ttlMs: ttl,
    grantedBy: undefined, grantedTs: undefined, expiresTs: undefined,
    taskDone: false, endedTs: undefined, endReason: undefined,
  };
  steer.grants.set(id, g);
  steerAudit({ ev: "control_request", id, sessionId, task: t, by: g.requestedBy, ttlMs: ttl });
  saveSteer().catch(() => {});
  return g;
}

// OPERATOR ONLY. Optional ttlMs overrides the requested TTL at grant time.
function controlGrant(id, by, ttlMs) {
  const g = steer.grants.get(id);
  if (!g || g.status !== GRANT_STATUS.REQUESTED) return g || null;
  const now = Date.now();
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : g.ttlMs;
  g.status = GRANT_STATUS.GRANTED;
  g.grantedBy = by || "operator";
  g.grantedTs = now;
  g.ttlMs = ttl;
  g.expiresTs = now + ttl; // TTL cap; task-done (release) can end it earlier
  steerAudit({ ev: "control_grant", id, sessionId: g.sessionId, by: g.grantedBy, ttlMs: ttl, task: g.task });
  saveSteer().catch(() => {});
  maybeTmuxDeliver(g.sessionId); // if idle+pane and the agent already queued, start now
  return g;
}

// OPERATOR ONLY.
function controlDeny(id, by) {
  const g = steer.grants.get(id);
  if (!g) return null;
  if (g.status === GRANT_STATUS.REQUESTED) {
    g.status = GRANT_STATUS.DENIED; g.endedTs = Date.now(); g.endReason = "denied";
    steerAudit({ ev: "control_deny", id, sessionId: g.sessionId, by: by || "operator" });
    saveSteer().catch(() => {});
  }
  return g;
}

// End an active/pending grant. reason "released" = the agent gave it back (safe, MCP-allowed);
// "revoked" = operator pulled it. Both are non-destructive — they just stop future autonomy.
function controlEnd(id, by, reason) {
  const g = steer.grants.get(id);
  if (!g) return null;
  if (g.status === GRANT_STATUS.REQUESTED || g.status === GRANT_STATUS.GRANTED) {
    g.status = reason === "released" ? GRANT_STATUS.RELEASED : GRANT_STATUS.REVOKED;
    g.taskDone = reason === "released";
    g.endedTs = Date.now(); g.endReason = reason;
    steerAudit({ ev: reason === "released" ? "control_release" : "control_revoke", id, sessionId: g.sessionId, by });
    saveSteer().catch(() => {});
  }
  return g;
}

// The agent releases by session id (it knows the session, not necessarily the grant id).
function controlReleaseBySession(sid, by) {
  const g = activeGrantFor(sid) || pendingGrantFor(sid);
  return g ? controlEnd(g.id, by || "agent", "released") : null;
}

// Compact per-session control state for the session detail + dashboard.
function controlSummaryFor(sid) {
  const now = Date.now();
  const active = activeGrantFor(sid);
  if (active) return { status: "granted", task: active.task, expiresMs: Math.max(0, (active.expiresTs || 0) - now), grantedBy: active.grantedBy };
  const pending = pendingGrantFor(sid);
  if (pending) return { status: "requested", task: pending.task, requestedBy: pending.requestedBy, ttlMs: pending.ttlMs };
  return { status: "none" };
}

function steerSetMode(sid, mode) {
  if (!sid) throw new Error("missing session_id");
  const m = normalizeMode(mode);
  if (!m) throw new Error(`invalid mode: ${mode} (use ${SESSION_MODES.join("|")})`);
  steer.modes.set(sid, m); // store even "off" so it overrides a non-off defaultMode
  steerAudit({ ev: "mode", sessionId: sid, mode: m });
  saveSteer().catch(() => {});
  return m;
}

function steerSetMaster(enabled) {
  steer.master = !!enabled;
  steerAudit({ ev: "master", enabled: steer.master });
  saveSteer().catch(() => {});
  return steer.master;
}

function steerConfig() {
  return { master: steer.master, defaultMode: steer.defaultMode, ttlMs: steer.ttlMs, autoKinds: steer.autoKinds, hookSteering: steer.hookSteering, queueCap: steer.queueCap };
}

function steerSetConfig(cfg = {}) {
  if (cfg.defaultMode !== undefined) {
    const m = normalizeMode(cfg.defaultMode);
    if (!m) throw new Error("invalid defaultMode");
    steer.defaultMode = m;
  }
  if (cfg.ttlMs !== undefined) {
    const t = parseInt(cfg.ttlMs, 10);
    if (!Number.isFinite(t) || t <= 0) throw new Error("invalid ttlMs");
    steer.ttlMs = t;
  }
  if (cfg.autoKinds !== undefined) {
    if (!Array.isArray(cfg.autoKinds)) throw new Error("autoKinds must be an array");
    steer.autoKinds = cfg.autoKinds.filter((k) => STEER_KINDS.includes(k) && k !== "block_tool");
  }
  if (cfg.hookSteering !== undefined) steer.hookSteering = !!cfg.hookSteering;
  if (cfg.queueCap !== undefined) {
    const q = parseInt(cfg.queueCap, 10);
    if (!Number.isFinite(q) || q <= 0) throw new Error("invalid queueCap");
    steer.queueCap = q;
  }
  steerAudit({ ev: "config", ...steerConfig() });
  saveSteer().catch(() => {});
  return steerConfig();
}

function steerList(sid) {
  let arr = [...steer.directives.values()];
  if (sid) arr = arr.filter((d) => d.sessionId === sid);
  arr.sort((a, b) => (b.createdTs || 0) - (a.createdTs || 0));
  return arr;
}

function steerSnapshot() {
  const directives = steerList();
  const pending = directives.filter((d) => d.status === STATUS.PROPOSED).length;
  const grants = [...steer.grants.values()].sort((a, b) => (b.requestedTs || 0) - (a.requestedTs || 0));
  const pendingControl = grants.filter(isGrantPending).length;
  return { ...steerConfig(), modes: Object.fromEntries(steer.modes), directives, pending, grants, pendingControl };
}

// Expire past-TTL directives AND grants; drop old terminal ones (audit log persists them).
function sweepSteer(now) {
  let changed = false;
  for (const d of steer.directives.values()) {
    if ((d.status === STATUS.PROPOSED || d.status === STATUS.ARMED) && isExpired(d, now)) {
      d.status = STATUS.EXPIRED;
      d.expiredTs = now;
      steerAudit({ ev: "expire", id: d.id, sessionId: d.sessionId, kind: d.kind });
      changed = true;
    }
  }
  // Grants: a granted-but-past-TTL grant expires (the TTL half of TTL+task-done scope).
  for (const g of steer.grants.values()) {
    if (g.status === GRANT_STATUS.GRANTED && g.expiresTs && now >= g.expiresTs) {
      g.status = GRANT_STATUS.EXPIRED; g.endedTs = now; g.endReason = "expired";
      steerAudit({ ev: "control_expire", id: g.id, sessionId: g.sessionId });
      changed = true;
    }
  }
  const KEEP_MS = 60 * 60 * 1000;
  for (const [id, d] of steer.directives) {
    const terminal = d.status === STATUS.DELIVERED || d.status === STATUS.EXPIRED || d.status === STATUS.CANCELLED;
    const tts = d.deliveredTs || d.expiredTs || d.cancelledTs || 0;
    if (terminal && tts && now - tts > KEEP_MS) { steer.directives.delete(id); changed = true; }
  }
  for (const [id, g] of steer.grants) {
    const terminal = [GRANT_STATUS.DENIED, GRANT_STATUS.RELEASED, GRANT_STATUS.REVOKED, GRANT_STATUS.EXPIRED].includes(g.status);
    if (terminal && g.endedTs && now - g.endedTs > KEEP_MS) { steer.grants.delete(id); changed = true; }
  }
  if (changed) saveSteer().catch(() => {});
  return changed;
}

// ---------------------------------------------------------------------------
// Data-access helpers — one source of truth for the REST routes AND the MCP tools.
// ---------------------------------------------------------------------------

// The steer status for a session — three ORTHOGONAL axes plus a net verdict, so any agent
// (the agent over MCP, or the dashboard) gets one truthful answer with a reason. Deliberately
// age-agnostic: a long-idle ("stale") agent with a live pane is the PRIME steering target,
// not an excluded one — staleness is a display hint, never a steer gate.
//
//   reach       : can we deliver, and how — live-pane | hook-only | unreachable | ended
//   permission  : are we allowed — off | approval | autonomous | controlled
//   canSteer    : net — permitted AND reachable (a queued directive will land)
//   deliverWhen : when it lands if canSteer — now | when-idle | next-hook
//   why         : the failing axis, when !canSteer
function steerStatusFor(s) {
  const sid = s.sessionId;
  const grant = activeGrantFor(sid);
  const baseMode = sessionMode(sid);
  const decision = s.awaitingDecision || false; // "plan" | "question" | false
  const readyNow = s.status === "idle" || !!decision; // a decision prompt is ready for input now

  let reach;
  if (s.status === "ended") reach = "ended";
  else if (s.tmux) reach = "live-pane";       // a registered pane → send-keys (idle, active, or deciding)
  else if (s.status === "working" || s.status === "starting" || s.status === "waiting") reach = "hook-only";
  else reach = "unreachable";                 // idle with no pane: no hook coming, nothing to type into

  const permission = grant ? "controlled" : baseMode;
  const permitted = !!steer.master && (baseMode !== "off" || !!grant);
  const reachable = reach === "live-pane" || (reach === "hook-only" && steer.hookSteering);
  const canSteer = permitted && reachable;

  let deliverWhen = null, why = null;
  if (canSteer) deliverWhen = reach === "live-pane" ? (readyNow ? "now" : "when-idle") : "next-hook";
  else if (!steer.master) why = "steering master switch is off";
  else if (!permitted) why = `not permitted: mode is ${baseMode} — set a mode or request control`;
  else if (reach === "ended") why = "session has ended";
  else if (reach === "unreachable") why = "idle with no live pane — launch via the steer wrapper to enable idle steering";
  else why = "no live pane and hook delivery is off";

  return {
    reach, permission, controlled: !!grant,
    pendingControl: !!pendingGrantFor(sid),
    grantExpiresMs: grant ? Math.max(0, (grant.expiresTs || 0) - Date.now()) : undefined,
    grantTask: grant ? grant.task : undefined,
    // awaitingDecision ⇒ answer it with a `decide` directive (text = the choice). decisionOptions
    // lists the AskUserQuestion labels when known.
    awaitingDecision: decision, decisionOptions: decision ? s.decisionOptions : undefined,
    pane: !!s.tmux, canSteer, deliverWhen, why,
  };
}

function apiSessions(opts = {}) {
  const now = Date.now();
  let rows = [...sessions.values()]
    .filter((s) => !matchesIgnore(s.repo, s.cwd))
    // steer: the full picture (reach × permission × control + net canSteer/why). Replaces the
    // old bare `steerable` boolean, which conflated "has a pane" with "can actually steer".
    .map((s) => ({ ...buildOverviewRow(s, now), steer: steerStatusFor(s) }));
  if (opts.activeOnly) rows = rows.filter((r) => r.status !== "stale" && r.status !== "ended");
  rows.sort((a, b) => (Number(b.attention) - Number(a.attention)) || (b.lastTs - a.lastTs));
  return rows;
}

async function apiDigest(sinceStr) {
  const sinceMs = parseSince(sinceStr || "30m");
  const cutoff = Date.now() - sinceMs;
  const rows = [];
  for (const s of sessions.values()) {
    if (matchesIgnore(s.repo, s.cwd)) continue;
    const windowed = await windowEvents(s, cutoff);
    if (!windowed.length) continue; // older-than-window sessions don't appear
    rows.push(buildDigestRow(s, windowed));
  }
  return { sinceMs, rows };
}

function apiSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  // Augment the detail with steer status + control state so the agent can poll (via
  // session_summary) whether it can steer / its request was granted, and the dashboard
  // can render the control row.
  return { ...buildDetail(s), steer: steerStatusFor(s), control: controlSummaryFor(id) };
}

function apiSessionEvents(id, typesStr, limit) {
  const s = sessions.get(id);
  if (!s) return null;
  const lim = parseInt(limit ?? 150, 10) || 150;
  const types = typesStr ? new Set(String(typesStr).split(",").map((t) => t.trim()).filter(Boolean)) : null;
  let buf = s.buffer;
  if (types) buf = buf.filter((e) => types.has(e.kind) || (e.tool && types.has(e.tool)));
  return buf.slice(-lim);
}

// Bounded transcript tail for the MCP tool — reads only the last maxBytes from disk
// (drops a partial leading line) so a huge transcript can't flood the agent's context.
function apiTranscriptText(id, maxBytes) {
  const s = sessions.get(id);
  if (!s || !s.transcriptPath || !fs.existsSync(s.transcriptPath)) return null;
  const cap = parseInt(maxBytes ?? 65536, 10) || 65536;
  const size = fs.statSync(s.transcriptPath).size;
  if (size <= cap) {
    return { text: fs.readFileSync(s.transcriptPath, "utf8"), truncated: false, bytes: size };
  }
  const fd = fs.openSync(s.transcriptPath, "r");
  try {
    const b = Buffer.alloc(cap);
    fs.readSync(fd, b, 0, cap, size - cap);
    let text = b.toString("utf8");
    const nl = text.indexOf("\n");
    if (nl >= 0) text = text.slice(nl + 1); // drop partial first line
    return { text, truncated: true, bytes: cap };
  } finally {
    fs.closeSync(fd);
  }
}

const mcpApi = {
  sessions: apiSessions,
  digest: apiDigest,
  session: apiSession,
  sessionEvents: apiSessionEvents,
  transcriptText: apiTranscriptText,
  // Write surface — steering. steerCreate throws (disabled/non-steerable/bad input),
  // which mcp.mjs turns into an isError result so the agent gets a clear reason. On success we
  // enrich with the session's reach so the agent learns whether/when the directive will land
  // (e.g. armed but the session has no live pane → it waits, it won't vanish silently).
  steerCreate: (req) => {
    const d = steerCreate(req);
    const st = sessions.has(d.sessionId) ? steerStatusFor(sessions.get(d.sessionId)) : null;
    return {
      id: d.id, status: d.status, kind: d.kind,
      reach: st ? st.reach : "unknown",
      willDeliver: !!(st && st.canSteer && d.status === "armed"),
      deliverWhen: st && d.status === "armed" ? st.deliverWhen : null,
      note: st && d.status === "armed" && !st.canSteer ? `armed but not deliverable yet: ${st.why}` : undefined,
    };
  },
  steerList,
  steerCancel: (id) => steerCancel(id, "agent"),
  // Control — the agent can REQUEST and RELEASE only. There is intentionally no grant here:
  // granting is operator-only (REST/dashboard), so the agent can never take control
  // of a session without explicit human consent.
  controlRequest: (req) => controlRequest({ ...req, by: "agent" }),
  controlRelease: (sid) => controlReleaseBySession(sid, "agent"),
};

// Prune ended/stale sessions to bound long-run memory.
function pruneSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    const old = now - s.lastTs > PRUNE_MS;
    if (old && (s.status === "ended" || s.status === "idle")) sessions.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Boot / shutdown
// ---------------------------------------------------------------------------

let persistTimer, pruneTimer;
async function main() {
  await ensureDir();
  // Drop the token where the local launch wrapper can read it (0600). Remove a stale file
  // when running tokenless so the wrapper doesn't send a dead bearer.
  // chmod too: writeFile's mode only applies when it creates the file, not to a pre-existing one.
  if (TOKEN) { try { await fsp.writeFile(TOKEN_FILE, TOKEN, { mode: 0o600 }); await fsp.chmod(TOKEN_FILE, 0o600); } catch (e) { console.error("token file:", e.message); } }
  else { try { await fsp.rm(TOKEN_FILE, { force: true }); } catch {} }
  seedIgnore();
  openSteerAudit();
  seedSteer();
  await loadState();
  await rehydrateBuffers();
  // Imported/loaded active sessions are historical until a live event resumes them.
  for (const s of sessions.values()) if (s.status === "working" || s.status === "starting") s.status = "idle";
  openEventsStream();

  persistTimer = setInterval(() => { saveState().catch((e) => console.error("saveState:", e.message)); rotateIfNeeded().catch(() => {}); }, PERSIST_MS);
  pruneTimer = setInterval(() => { pruneSessions(); sweepSteer(Date.now()); }, 60 * 60 * 1000);

  server.listen(PORT, HOST, () => {
    console.log(`observer listening on ${HOST}:${PORT}`);
    console.log(`  summaries: ${vertex ? `enabled (vertex ${VERTEX_CONFIG.model}, project ${VERTEX_CONFIG.project})` : "disabled (no GOOGLE_APPLICATION_CREDENTIALS)"}`);
    console.log(`  auth: ${TOKEN ? "bearer required on /events,/api,/stream,/transcript,/mcp" : "open (OBSERVER_TOKEN unset — dev mode)"}`);
    console.log(`  mcp: POST /mcp (remote MCP, ${TOOLS.length} tools: ${TOOLS.map((t) => t.name).join(", ")})`);
    console.log(`  steering: ${steer.master ? "on" : "off"} (default mode ${steer.defaultMode}, hook-delivery ${steer.hookSteering ? "on" : "off (idle-pane only)"}, ${steer.modes.size} session override(s), ${steerSnapshot().pending} pending approval)`);
    console.log(`  ignore: ${ignored.size ? [...ignored].sort().join(", ") : "(none)"}`);
    console.log(`  data: ${DATA_DIR}`);
    console.log(`  sessions loaded: ${sessions.size}`);
  });
}

async function shutdown(sig) {
  console.log(`\n${sig} — saving state…`);
  clearInterval(persistTimer); clearInterval(pruneTimer);
  try { await saveState(); } catch (e) { console.error("final saveState:", e.message); }
  try { await saveSteer(); } catch (e) { console.error("final saveSteer:", e.message); }
  if (eventsStream) eventsStream.end();
  if (steerAuditStream) steerAuditStream.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Embedded dashboard — vanilla, self-contained, dark ops-console.
const DASHBOARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>observer</title>
<style>
:root{--bg:#0b0e14;--fg:#c9d1d9;--dim:#6e7681;--line:#1c2128;--acc:#58a6ff;--warn:#f0b429;--err:#f85149;--ok:#3fb950}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
header{display:flex;gap:14px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}
h1{font-size:13px;margin:0;color:var(--acc);font-weight:600}
select,button{background:#11151c;color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:3px 6px;font:inherit}
.stamp{color:var(--dim);margin-left:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--dim);font-weight:500;position:sticky;top:37px;background:var(--bg)}
tr.row{cursor:pointer}tr.row:hover{background:#11151c}
tr.attn td:first-child{box-shadow:inset 3px 0 0 var(--err)}
.badge{padding:1px 6px;border-radius:10px;font-size:11px}
.s-working{background:#10331f;color:var(--ok)}.s-waiting{background:#3a2d08;color:var(--warn)}
.s-idle{background:#1c2128;color:var(--dim)}.s-stale{background:#1c2128;color:var(--dim)}
.s-starting{background:#0d2b40;color:var(--acc)}.s-ended{background:#2d1416;color:var(--err)}
.num{color:var(--fg)}.zero{color:var(--dim)}.err{color:var(--err)}
.detail{background:#0d1117;padding:10px 18px;white-space:normal}
.detail h3{margin:8px 0 4px;color:var(--acc);font-size:12px}
.kv{color:var(--dim)}code{color:#a5d6ff}
.files div,.tasks div{padding:1px 0}
.filters button{margin-right:4px}
.ev{border-bottom:1px solid var(--line);padding:2px 0;color:var(--dim)}
.ev .k{display:inline-block;width:90px;color:var(--acc)}
.now{color:var(--dim);max-width:380px;overflow:hidden;text-overflow:ellipsis}
.bar{display:flex;gap:8px;align-items:center;padding:6px 12px;border-bottom:1px solid var(--line);font-size:11px;flex-wrap:wrap}
.bar input[type=text]{background:#11151c;color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:3px 6px;font:inherit;width:170px}
.chip{display:inline-flex;align-items:center;gap:5px;background:#1c2128;border:1px solid var(--line);border-radius:10px;padding:1px 7px}
.chip b{color:var(--warn);font-weight:500}
.chip .x{cursor:pointer;color:var(--dim)}.chip .x:hover{color:var(--err)}
.ign{cursor:pointer;color:var(--dim);margin-left:6px;opacity:0}
tr.row:hover .ign{opacity:1}.ign:hover{color:var(--err)}
.pend{color:var(--warn);font-weight:600}
#steerbtn.on{color:var(--ok);border-color:#10331f}#steerbtn.off{color:var(--dim)}
.steer{margin-top:8px;border-top:1px dashed var(--line);padding-top:6px}
.steer h3{margin:6px 0 4px}
.dir{display:flex;gap:6px;align-items:center;padding:2px 0;flex-wrap:wrap}
.dst{padding:0 6px;border-radius:8px;font-size:10px}
.dst-proposed{background:#3a2d08;color:var(--warn)}.dst-armed{background:#10331f;color:var(--ok)}
.dst-delivered{background:#0d2b40;color:var(--acc)}.dst-expired,.dst-cancelled{background:#1c2128;color:var(--dim)}
.steer input,.steer select{background:#11151c;color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:2px 5px;font:inherit}
.steer .txt{width:260px}.steer .tm{width:70px}
.pendpanel{padding:4px 12px;border-bottom:1px solid var(--line);background:#150f02}
.pendpanel .dir{padding:1px 0}
</style></head><body>
<header>
<h1>observer</h1>
<label>window <select id="win"><option>15m</option><option selected>30m</option><option>2h</option><option>12h</option></select></label>
<label><input type="checkbox" id="active"> active only</label>
<label><input type="checkbox" id="auto" checked> auto</label>
<button id="refresh">refresh</button>
<button id="tokbtn">token</button>
<button id="steerbtn" class="off">steering: ?</button>
<span class="pend" id="pendbadge"></span>
<span class="stamp" id="stamp"></span>
</header>
<div class="bar">
<span class=kv>ignore:</span><span id="ignlist"></span>
<input type="text" id="ignin" placeholder="repo name or path…">
<button id="ignadd">+ add</button>
</div>
<div class="bar" id="steerbar">
<span class=kv>steering cfg:</span>
<label>default <select id="sdefault"><option value="off">off</option><option value="approval">approval</option><option value="autonomous">autonomous</option></select></label>
<label>ttl <input type="text" id="sttl" style="width:46px"> min</label>
<label>auto-arm <input type="text" id="sauto" placeholder="context,nudge,decide" style="width:150px"></label>
<label title="deliver nudge/context via the hook response (Stop/UserPromptSubmit). Off = idle-pane only. block_tool always uses its hook."><input type="checkbox" id="shook"> hook delivery</label>
<button id="scfg">save cfg</button>
</div>
<div class="pendpanel" id="pendpanel" style="display:none"></div>
<table><thead><tr>
<th>repo@branch</th><th>status</th><th>age</th><th>turns</th><th>tools</th><th>edits</th><th>bash</th><th>err</th><th>files</th><th>tasks</th><th>doing now</th>
</tr></thead><tbody id="tb"></tbody></table>
<script>
const $=s=>document.querySelector(s);
let open=new Set();
let steerState={master:false,defaultMode:'off',ttlMs:900000,autoKinds:['context','nudge','decide'],hookSteering:false,modes:{},directives:[],pending:0,grants:[],pendingControl:0};
// Per-row steer chip: permission, pane (reach) and net canSteer in one glance. Mirrors the
// steer object the MCP surface exposes, so dashboard and the agent read the same vocabulary.
function steerChip(st){
  if(!st)return '';
  const p=[];
  if(st.awaitingDecision)p.push('<span title="awaiting '+(st.awaitingDecision==='plan'?'plan approval':'an answer')+' — send a decide directive" style="color:var(--warn)">'+(st.awaitingDecision==='plan'?'⏯plan?':'❓ask?')+'</span>');
  if(st.pendingControl)p.push('<span title="control requested — awaiting your approval" style="color:var(--warn)">⏳control?</span>');
  if(st.controlled)p.push('<span title="controlled by the agent: '+esc(st.grantTask||'')+'" style="color:var(--ok)">🎮'+age(st.grantExpiresMs||0)+'</span>');
  else if(st.permission==='approval')p.push('<span title="approval mode — you approve each directive">✋</span>');
  else if(st.permission==='autonomous')p.push('<span title="autonomous">⚡</span>');
  else p.push('<span title="not permitted (mode off)" style="color:var(--dim)">🔒</span>');
  if(st.pane)p.push('<span title="live pane'+(st.canSteer&&st.deliverWhen?' — delivers '+st.deliverWhen:'')+'" style="'+(st.canSteer?'color:var(--ok)':'')+'">🖥</span>');
  // permitted-but-not-reachable: the surprising case worth flagging.
  if((st.controlled||st.permission!=='off')&&!st.canSteer&&st.why)p.push('<span title="'+esc(st.why)+'" style="color:var(--warn)">⚠</span>');
  return ' '+p.join(' ');
}
// Auth: the read API is bearer-gated, so the dashboard sends OBSERVER_TOKEN too.
function getTok(){return localStorage.getItem('observer_token')||''}
function askTok(){const t=prompt('OBSERVER_TOKEN (blank if the collector runs without one):',getTok());if(t!==null)localStorage.setItem('observer_token',t);}
// Prompt for the token at most once per failure streak — a cancelled prompt must not re-open
// on every 4s refresh. The token button clears the flag and asks again.
let authBlocked=false;
async function api(path,opts){
  opts=opts||{};const base=opts.headers||{};
  const hdr=()=>{const t=getTok();return t?Object.assign({},base,{authorization:'Bearer '+t}):base;};
  let r=await fetch(path,Object.assign({},opts,{headers:hdr()}));
  if(r.status===401&&!authBlocked){authBlocked=true;askTok();r=await fetch(path,Object.assign({},opts,{headers:hdr()}));}
  if(r.status===401)$('#stamp').textContent='unauthorized — set token';else authBlocked=false;
  return r;
}
function age(ms){if(ms<0)ms=0;const s=ms/1e3;if(s<60)return Math.floor(s)+'s';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';return Math.floor(s/86400)+'d'}
function num(n){return '<span class="'+(n?'num':'zero')+'">'+n+'</span>'}
function esc(s){return (s||'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}
async function load(){
  await loadSteer();
  const q=$('#active').checked?'?active=1':'';
  let rows;try{rows=await (await api('/api/sessions'+q)).json();}catch(e){return;}
  const tb=$('#tb');tb.innerHTML='';
  for(const r of rows){
    const repoBase=(r.repo||'').split('@')[0];
    const tr=document.createElement('tr');tr.className='row'+(r.attention?' attn':'');
    tr.innerHTML='<td>'+esc(r.repo||r.sessionId.slice(0,8))+(r.title?' <span class=kv>'+esc(r.title.slice(0,40))+'</span>':'')+
        steerChip(r.steer)+
        ' <span class=ign title="ignore '+esc(repoBase)+'">⊘</span></td>'+
      '<td><span class="badge s-'+r.status+'">'+r.status+'</span></td>'+
      '<td>'+age(r.ageMs)+'</td><td>'+num(r.turns)+'</td><td>'+num(r.toolCalls)+'</td><td>'+num(r.edits)+'</td>'+
      '<td>'+num(r.bash)+'</td><td>'+(r.errors?'<span class=err>'+r.errors+'</span>':num(0))+'</td>'+
      '<td>'+num(r.fileCount)+'</td><td>'+r.tasksDone+'/'+(r.tasksOpen+r.tasksDone)+'</td>'+
      '<td class="now">'+esc(r.now||'')+'</td>';
    tr.onclick=()=>toggle(r.sessionId,tr);
    const ig=tr.querySelector('.ign');if(ig)ig.onclick=e=>{e.stopPropagation();if(repoBase)ignore('add',repoBase);};
    tb.appendChild(tr);
    if(open.has(r.sessionId))await expand(r.sessionId,tr);
  }
  $('#stamp').textContent=new Date().toLocaleTimeString();
}
async function toggle(id,tr){if(open.has(id)){open.delete(id);const n=tr.nextSibling;if(n&&n.classList.contains('drow'))n.remove();}else{open.add(id);await expand(id,tr);}}
async function expand(id,tr){
  const d=await (await api('/api/session/'+encodeURIComponent(id))).json();
  let row=tr.nextSibling;if(!row||!row.classList.contains('drow')){row=document.createElement('tr');row.className='drow';row.innerHTML='<td colspan=11 class=detail></td>';tr.after(row);}
  const c=row.firstChild;
  const files=Object.entries(d.files||{}).map(([f,n])=>'<div><span class=kv>'+n+'×</span> '+esc(f)+'</div>').join('')||'<div class=kv>none</div>';
  const tasks=Object.values(d.tasks||{}).map(t=>'<div>['+t.status+'] '+esc(t.subject||'')+'</div>').join('')||'<div class=kv>none</div>';
  c.innerHTML='<h3>summary</h3><div>'+(esc(d.summary)||'<span class=kv>none</span>')+'</div>'+
    '<h3>files touched</h3><div class=files>'+files+'</div>'+
    '<h3>tasks</h3><div class=tasks>'+tasks+'</div>'+
    '<h3>recent events <span class=filters><button data-f="">all</button><button data-f="tool">tool</button><button data-f="tool_result">tool_result</button><button data-f="prompt">prompt</button></span></h3>'+
    '<div class=evs id=evs_'+css(id)+'></div>'+
    steerSection(id,d.steer);
  c.querySelectorAll('.filters button').forEach(b=>b.onclick=e=>{e.stopPropagation();loadEvents(id,b.dataset.f);});
  const ms=c.querySelector('[data-mode]');if(ms)ms.onchange=e=>{e.stopPropagation();steerAction('/api/steer/mode',{sessionId:id,mode:e.target.value});};
  const ab=c.querySelector('[data-add]');if(ab)ab.onclick=e=>{e.stopPropagation();const sec=ab.closest('.steer');const text=sec.querySelector('.txt').value.trim();if(!text)return;queueSteer(id,sec.querySelector('.skind').value,text,sec.querySelector('.tm').value.trim());};
  const cq=c.querySelector('[data-creq]');if(cq)cq.onclick=async e=>{e.stopPropagation();const task=c.querySelector('.ctltask').value.trim();if(!task)return;const r=await api('/api/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:id,task})});let g={};try{g=await r.json();}catch(_){}if(g&&g.id){await steerAction('/api/control/'+encodeURIComponent(g.id)+'/grant');}else{alert('control failed: '+(g.error||r.status));}};
  wireDirButtons(c);wireControlButtons(c);
  loadEvents(id,'');
}
function css(s){return s.replace(/[^a-z0-9]/gi,'_')}
async function loadEvents(id,f){
  const u='/api/session/'+encodeURIComponent(id)+'/events?limit=80'+(f?'&types='+f:'');
  const evs=await (await api(u)).json();
  const el=document.getElementById('evs_'+css(id));if(!el)return;
  el.innerHTML=evs.map(e=>'<div class=ev><span class=k>'+esc(e.kind)+'</span>'+esc(e.tool?e.tool+' ':'')+esc((e.prompt||e.input&&e.input.file_path||e.input&&e.input.command||'')+'').slice(0,160)+(e.isError?' <span class=err>ERR</span>':'')+'</div>').join('')||'<div class=kv>none</div>';
}
// Ignore list management.
async function loadIgnore(){
  let j;try{j=await (await api('/api/ignore')).json();}catch(e){return;}
  const el=$('#ignlist');
  el.innerHTML=(j.ignore||[]).map(e=>'<span class=chip><b>'+esc(e)+'</b><span class=x data-e="'+esc(e)+'">×</span></span>').join(' ')||'<span class=kv>none</span>';
  el.querySelectorAll('.x').forEach(x=>x.onclick=()=>ignore('remove',x.dataset.e));
}
async function ignore(op,val){
  if(!val)return;
  const body=op==='add'?{add:[val]}:{remove:[val]};
  await api('/api/ignore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  await loadIgnore();await load();
}
// Steering controls — master switch, config, per-session mode, directive approve/cancel.
async function loadSteer(){
  let j;try{j=await (await api('/api/steer')).json();}catch(e){return;}
  steerState=j;
  const btn=$('#steerbtn');btn.textContent='steering: '+(j.master?'ON':'off');btn.className=j.master?'on':'off';
  $('#pendbadge').textContent=[j.pending?j.pending+' pending':'',j.pendingControl?j.pendingControl+' control?':''].filter(Boolean).join(' · ');
  if($('#sdefault'))$('#sdefault').value=j.defaultMode;
  if($('#sttl')&&document.activeElement!==$('#sttl'))$('#sttl').value=Math.round((j.ttlMs||0)/60000);
  if($('#sauto')&&document.activeElement!==$('#sauto'))$('#sauto').value=(j.autoKinds||[]).join(',');
  if($('#shook'))$('#shook').checked=!!j.hookSteering;
  renderPending();
}
function dirInner(d,withApprove){
  let h='<span class="dst dst-'+d.status+'">'+esc(d.status)+'</span> <b>'+esc(d.kind)+'</b>'+(d.toolMatch?'('+esc(d.toolMatch)+')':'')+' '+esc((d.text||'').slice(0,90));
  if(withApprove&&d.status==='proposed')h+=' <button data-ap="'+esc(d.id)+'">approve</button>';
  if(d.status==='proposed'||d.status==='armed')h+=' <button data-cx="'+esc(d.id)+'">cancel</button>';
  return h;
}
function wireDirButtons(el){
  el.querySelectorAll('[data-ap]').forEach(b=>b.onclick=e=>{e.stopPropagation();steerAction('/api/steer/'+encodeURIComponent(b.dataset.ap)+'/approve');});
  el.querySelectorAll('[data-cx]').forEach(b=>b.onclick=e=>{e.stopPropagation();steerAction('/api/steer/'+encodeURIComponent(b.dataset.cx)+'/cancel');});
}
function renderPending(){
  const el=$('#pendpanel');
  const pend=(steerState.directives||[]).filter(d=>d.status==='proposed');
  const creq=(steerState.grants||[]).filter(g=>g.status==='requested');
  if(!pend.length&&!creq.length){el.style.display='none';el.innerHTML='';return;}
  el.style.display='';
  let h='';
  if(creq.length)h+='<span class=kv>control requests (the agent wants to take over):</span>'+creq.map(g=>
    '<div class=dir><span class=kv>'+esc(g.sessionId.slice(0,8))+'</span> <b style="color:var(--warn)">🎮 '+esc((g.task||'').slice(0,90))+'</b> '+
    '<span class=kv>('+Math.round((g.ttlMs||0)/60000)+'m, by '+esc(g.requestedBy||'')+')</span> '+
    '<button data-cg="'+esc(g.id)+'">approve</button> <button data-cd="'+esc(g.id)+'">deny</button></div>').join('');
  if(pend.length)h+='<span class=kv>pending approval:</span>'+pend.map(d=>'<div class=dir><span class=kv>'+esc(d.sessionId.slice(0,8))+'</span> '+dirInner(d,true)+'</div>').join('');
  el.innerHTML=h;
  wireDirButtons(el);wireControlButtons(el);
}
// Control grant/deny/revoke buttons (operator-only actions).
function wireControlButtons(el){
  el.querySelectorAll('[data-cg]').forEach(b=>b.onclick=e=>{e.stopPropagation();steerAction('/api/control/'+encodeURIComponent(b.dataset.cg)+'/grant');});
  el.querySelectorAll('[data-cd]').forEach(b=>b.onclick=e=>{e.stopPropagation();steerAction('/api/control/'+encodeURIComponent(b.dataset.cd)+'/deny');});
  el.querySelectorAll('[data-cr]').forEach(b=>b.onclick=e=>{e.stopPropagation();steerAction('/api/control/'+encodeURIComponent(b.dataset.cr)+'/revoke');});
}
function controlFor(id){
  const gs=(steerState.grants||[]).filter(g=>g.sessionId===id);
  return {active:gs.find(g=>g.status==='granted'),pending:gs.find(g=>g.status==='requested')};
}
async function steerAction(path,body){
  await api(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
  await loadSteer();await load();
}
function steerSection(id,st){
  const mode=(steerState.modes&&steerState.modes[id])||steerState.defaultMode;
  const dirs=(steerState.directives||[]).filter(d=>d.sessionId===id);
  const opts=['off','approval','autonomous'].map(m=>'<option value="'+m+'"'+(m===mode?' selected':'')+'>'+m+'</option>').join('');
  // When the session is blocked on a decision, prompt the operator to answer it with a decide directive.
  const dec=st&&st.awaitingDecision?'<div class=dir style="color:var(--warn)">awaiting '+(st.awaitingDecision==='plan'?'plan approval':'an answer')+' — queue a <b>decide</b> ('+(st.awaitingDecision==='plan'?'"accept" or an option #':'option # / label / text')+(st.decisionOptions&&st.decisionOptions.length?'; options: '+esc(st.decisionOptions.join(' | ')):'')+')</div>':'';
  const list=dirs.length?dirs.map(d=>'<div class=dir>'+dirInner(d,true)+'</div>').join(''):'<div class=kv>none</div>';
  const ctl=controlFor(id);
  let ctlrow;
  if(ctl.active)ctlrow='control <b style="color:var(--ok)">🎮 granted</b> '+esc((ctl.active.task||'').slice(0,80))+' <span class=kv>('+age(Math.max(0,(ctl.active.expiresTs||0)-Date.now()))+' left)</span> <button data-cr="'+esc(ctl.active.id)+'">revoke</button>';
  else if(ctl.pending)ctlrow='control <b style="color:var(--warn)">⏳ requested</b> '+esc((ctl.pending.task||'').slice(0,80))+' <button data-cg="'+esc(ctl.pending.id)+'">approve</button> <button data-cd="'+esc(ctl.pending.id)+'">deny</button>';
  else ctlrow='control <span class=kv>none</span> <input class="ctltask" placeholder="task to take over" style="width:200px"><button data-creq="'+esc(id)+'">request+grant</button>';
  return '<div class=steer><h3>steering</h3>'+
    '<div class=dir>mode <select data-mode="'+esc(id)+'">'+opts+'</select> <span class=kv>(master '+(steerState.master?'on':'off')+')</span></div>'+
    '<div class=dir>'+ctlrow+'</div>'+
    dec+
    list+
    '<div class=dir><select class=skind><option value=nudge>nudge</option><option value=context>context</option><option value=decide>decide</option><option value=block_tool>block_tool</option></select>'+
    '<input class="txt" placeholder="instruction / context / reason / decide choice">'+
    '<input class="tm" placeholder="tool (block_tool)">'+
    '<button data-add="'+esc(id)+'">queue</button></div></div>';
}
async function queueSteer(id,kind,text,toolMatch){
  const r=await api('/api/steer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:id,kind,text,toolMatch:toolMatch||undefined})});
  if(!r.ok){let j={};try{j=await r.json();}catch(e){}alert('steer failed: '+(j.error||r.status));return;}
  await loadSteer();await load();
}
$('#steerbtn').onclick=()=>steerAction('/api/steer/master',{enabled:!steerState.master});
$('#scfg').onclick=()=>{const dm=$('#sdefault').value;const ttlMs=Math.max(1,parseInt($('#sttl').value||'15',10))*60000;const autoKinds=$('#sauto').value.split(',').map(s=>s.trim()).filter(Boolean);const hookSteering=$('#shook').checked;steerAction('/api/steer/config',{defaultMode:dm,ttlMs,autoKinds,hookSteering});};
$('#refresh').onclick=load;
$('#active').onchange=load;
$('#tokbtn').onclick=()=>{authBlocked=false;askTok();loadIgnore();load();};
$('#ignadd').onclick=()=>{const v=$('#ignin').value.trim();$('#ignin').value='';ignore('add',v);};
$('#ignin').addEventListener('keydown',e=>{if(e.key==='Enter'){const v=e.target.value.trim();e.target.value='';ignore('add',v);}});
// Auto-refresh rebuilds the expanded rows, so hold it while the operator is typing into (or
// has an unsent draft in) a steer/control input — otherwise the text is wiped mid-edit.
function editing(){const a=document.activeElement;if(a&&a.closest&&a.closest('#tb')&&/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName))return true;
  return [...document.querySelectorAll('#tb .txt,#tb .tm,#tb .ctltask')].some(i=>i.value.trim());}
setInterval(()=>{if(!$('#auto').checked)return;if(editing()){$('#stamp').textContent='paused — unsent input';return;}load();},4000);
loadIgnore();load();
</script></body></html>`;

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
