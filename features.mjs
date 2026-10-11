// features.mjs — feature records: group a workspace's sessions under the feature it builds.
//
// A workspace root (a checkout or git worktree) may carry `features/<slug>/status.json`, a
// small machine-readable record of the feature being built there. observer knows ONLY this
// file shape — nothing about whichever tool writes it. A record is ACTIVE when its `branch`
// equals the branch checked out in that root; records for other branches are inherited
// history and are ignored.
//
//   session cwd ──► walk UP (bounded) ──► nearest dir with features/ + an active record
//                                              │
//                    readWorkspace(dir) ◄──────┘   (disk, cached per dir for a few seconds)
//                         │
//   sessions + rows ──► buildFeatures() ──► [{ ...record, root, sessions, targetSessionId }]
//
// The record is UNTRUSTED input: sanitizeRecord() whitelists fields, type-checks, caps
// sizes and strips control characters; anything invalid is dropped, never thrown. The top
// half of this file is pure (sanitize / walk / target / sort / assemble). The bottom half
// is the only disk I/O: async, size-capped reads behind a short TTL cache, called from the
// READ path only — never from ingest, never from reduce().

import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readCheckedOutBranch } from "./gitinfo.mjs";

export const FEATURES_DIR = "features";
export const RECORD_FILE = "status.json";
export const MAX_RECORD_BYTES = 64 * 1024; // a bigger status.json is ignored, not truncated
export const MAX_RECORDS_PER_ROOT = 200;   // record dirs read per workspace per refresh
export const MAX_WALK_DEPTH = 8;           // ancestors checked per session cwd
export const WORKSPACE_TTL_MS = 5000;      // per-dir cache lifetime

const CAP = {
  feature: 120, branch: 250, title: 200, mode: 40, stage: 40, now: 300,
  question: 500, option: 200, options: 8, recommendation: 200,
  what: 300, evidence: 300, verified: 50,
  repo: 100, url: 500, prs: 20,
  label: 40, text: 2000, actions: 8,
};

// ---------------------------------------------------------------------------
// Sanitising (pure)
// ---------------------------------------------------------------------------

// One line of plain text, or undefined. Control characters (newlines, ESC, …) become
// spaces: every string here can end up typed into a terminal by a steering directive.
function flat(v) {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return t || undefined;
}

// Display text: over-long values are shortened with an ellipsis.
function text(v, max) {
  const t = flat(v);
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// Load-bearing text (identity, branch, an instruction): over-long values are rejected
// outright — a silently shortened branch never matches and a shortened instruction lies.
function exact(v, max) {
  const t = flat(v);
  return t && t.length <= max ? t : undefined;
}

// ISO timestamp normalised through Date, or undefined.
function iso(v) {
  if (typeof v !== "string" || v.length > 40) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

// https:// only, no embedded credentials; returned re-serialised by the URL parser.
function httpsUrl(v) {
  if (typeof v !== "string" || v.length > CAP.url) return undefined;
  let u;
  try { u = new URL(v.trim()); } catch { return undefined; }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return undefined;
  return u.href;
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// Map an untrusted array through `fn`, dropping what it rejects, keeping at most `max`.
function list(v, max, fn) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (out.length >= max) break;
    const clean = fn(item);
    if (clean !== undefined) out.push(clean);
  }
  return out;
}

// Drop undefined keys so the JSON shape is "present and valid, or absent".
function compact(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

function cleanWaiting(v) {
  if (!isObj(v)) return null;
  const question = text(v.question, CAP.question);
  if (!question) return null; // nothing to show the operator → not waiting
  return compact({
    question,
    options: list(v.options, CAP.options, (o) => text(o, CAP.option)),
    recommendation: text(v.recommendation, CAP.recommendation),
    since: iso(v.since),
  });
}

// untrusted parsed JSON -> clean record, or null when it isn't a usable record. `feature`
// and `branch` are required; everything else is optional and dropped when invalid.
// Unknown fields are ignored (whitelist), so the output shape is fixed:
//   { feature, branch, title?, mode?, stage?, now?, waiting: {…}|null,
//     verified: [], prs: [], actions: [], created?, updated? }
export function sanitizeRecord(raw) {
  if (!isObj(raw)) return null;
  const feature = exact(raw.feature, CAP.feature);
  const branch = exact(raw.branch, CAP.branch);
  if (!feature || !branch) return null;
  return compact({
    feature,
    branch,
    title: text(raw.title, CAP.title),
    mode: text(raw.mode, CAP.mode),
    stage: text(raw.stage, CAP.stage),
    now: text(raw.now, CAP.now),
    waiting: cleanWaiting(raw.waiting),
    verified: list(raw.verified, CAP.verified, (v) => {
      const what = isObj(v) ? text(v.what, CAP.what) : undefined;
      return what ? compact({ what, evidence: text(v.evidence, CAP.evidence), at: iso(v.at) }) : undefined;
    }),
    prs: list(raw.prs, CAP.prs, (p) => {
      const url = isObj(p) ? httpsUrl(p.url) : undefined;
      return url ? compact({ repo: text(p.repo, CAP.repo), url }) : undefined;
    }),
    actions: list(raw.actions, CAP.actions, (a) => {
      if (!isObj(a)) return undefined;
      const label = text(a.label, CAP.label);
      const instruction = exact(a.text, CAP.text);
      return label && instruction ? { label, text: instruction } : undefined;
    }),
    created: iso(raw.created),
    updated: iso(raw.updated),
  });
}

// status.json text -> clean record | null. Malformed JSON is just "no record".
export function parseRecord(jsonText) {
  let raw;
  try { raw = JSON.parse(jsonText); } catch { return null; }
  return sanitizeRecord(raw);
}

// ---------------------------------------------------------------------------
// Matching, targeting, sorting (pure)
// ---------------------------------------------------------------------------

// The directories that could be the workspace root for a session running in `cwd`:
// cwd itself, then its ancestors, nearest first. Bounded three ways — it never includes
// the home directory or the filesystem root, and stops after `maxDepth` levels — so a
// session in a deep or unrelated path costs a handful of lookups at most.
export function candidateRoots(cwd, { home = os.homedir(), maxDepth = MAX_WALK_DEPTH } = {}) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return [];
  const stop = home ? path.resolve(home) : null;
  const out = [];
  let dir = path.resolve(cwd);
  while (out.length < maxDepth) {
    const parent = path.dirname(dir);
    if (parent === dir || dir === stop) break;
    out.push(dir);
    dir = parent;
  }
  return out;
}

// The records that are live for a root on `branch`. Everything else is inherited history.
export function activeRecords(records, branch) {
  if (!branch) return [];
  return records.filter((r) => r && r.branch === branch);
}

// Which session an instruction for the feature goes to by default. `sessions` are
// { sessionId, cwd, status, lastTs }. Preference: the most recently active non-ended
// session sitting AT the workspace root (the one driving the feature, rather than a helper
// in a nested repo) → the most recently active non-ended session anywhere in it → the
// most recently active session at all. null when there are none.
export function pickSteerTarget(root, sessions) {
  const at = root ? path.resolve(root) : null;
  const newest = (arr) => arr.reduce((best, s) => (!best || (s.lastTs || 0) > (best.lastTs || 0) ? s : best), null);
  const live = sessions.filter((s) => s.status !== "ended");
  const pick = newest(live.filter((s) => at && s.cwd && path.resolve(s.cwd) === at)) || newest(live) || newest(sessions);
  return pick ? pick.sessionId : null;
}

const updatedMs = (f) => {
  const ms = f.updated ? Date.parse(f.updated) : NaN;
  if (Number.isFinite(ms)) return ms;
  return (f.sessions || []).reduce((m, r) => Math.max(m, r.lastTs || 0), 0); // no `updated` → last session activity
};

// Features that need the operator first: a pending `waiting` question, then any session
// flagged attention (the existing per-session logic), then most recently updated.
export function sortFeatures(features) {
  const rank = (f) => (f.waiting ? 0 : (f.sessions || []).some((r) => r.attention) ? 1 : 2);
  return [...features].sort((a, b) =>
    (rank(a) - rank(b)) || (updatedMs(b) - updatedMs(a)) ||
    String(a.root).localeCompare(String(b.root)) || String(a.slug).localeCompare(String(b.slug)));
}

// Assemble the /api/features rows. `members` is one entry per session:
//   { workspace: { root, branch, features: [record…] } | null, cwd, row }
// where `row` is the session's overview row exactly as /api/sessions returns it. Sessions
// with no workspace are skipped. Each feature gets its workspace's sessions (attention-
// first, then most recent — the /api/sessions order) and a default steering target.
export function buildFeatures(members) {
  const groups = new Map(); // root -> { workspace, members: [] }
  for (const m of members) {
    if (!m || !m.workspace) continue;
    let g = groups.get(m.workspace.root);
    if (!g) groups.set(m.workspace.root, (g = { workspace: m.workspace, members: [] }));
    g.members.push(m);
  }
  const out = [];
  for (const { workspace, members: ms } of groups.values()) {
    const rows = ms.map((m) => m.row)
      .sort((a, b) => (Number(b.attention) - Number(a.attention)) || (b.lastTs - a.lastTs));
    const targetSessionId = pickSteerTarget(workspace.root,
      ms.map((m) => ({ sessionId: m.row.sessionId, cwd: m.cwd, status: m.row.status, lastTs: m.row.lastTs })));
    for (const record of workspace.features) {
      out.push({
        ...record,
        root: workspace.root,
        attention: !!record.waiting || rows.some((r) => r.attention),
        targetSessionId,
        sessions: rows,
      });
    }
  }
  return sortFeatures(out);
}

// ---------------------------------------------------------------------------
// Disk (async, capped, cached) — read path only
// ---------------------------------------------------------------------------

const cache = new Map(); // dir -> { ts, value: Promise<workspace | null> }
const CACHE_CAP = 2000;

// Read one status.json. Only a regular file within the size cap is opened, and the read
// itself is bounded too, so a FIFO, a directory or a file that grew mid-read costs nothing.
async function readRecord(file) {
  let fh;
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_RECORD_BYTES) return null;
    fh = await fsp.open(file, "r");
    const buf = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_RECORD_BYTES) return null;
    return parseRecord(buf.toString("utf8", 0, bytesRead));
  } catch { return null; } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// dir -> { root, branch, features: [{ slug, ...record }] } when `dir` is a workspace root
// with at least one ACTIVE record, else null. The cheap rejections come first: most
// directories have no features/ at all, and one that does but isn't a checkout root (some
// repo's src/features) is dismissed by the branch lookup before any record is read.
async function readWorkspace(dir) {
  let entries;
  try { entries = await fsp.readdir(path.join(dir, FEATURES_DIR), { withFileTypes: true }); } catch { return null; }
  const branch = readCheckedOutBranch(dir); // `.git` DIR or worktree `.git` FILE, read at dir exactly
  if (!branch) return null;
  // Likeliest slug first (the convention names the record dir after its branch), so the
  // per-root cap can't hide the active record behind a long tail of inherited ones.
  const leaf = branch.split("/").pop();
  const slugs = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name)
    .sort((a, b) => (Number(b === branch || b === leaf) - Number(a === branch || a === leaf)) || a.localeCompare(b))
    .slice(0, MAX_RECORDS_PER_ROOT);
  const records = [];
  for (const slug of slugs) {
    const record = await readRecord(path.join(dir, FEATURES_DIR, slug, RECORD_FILE));
    if (record) records.push({ slug, ...record });
  }
  const features = activeRecords(records, branch);
  return features.length ? { root: dir, branch, features } : null;
}

// Cached readWorkspace. The cache holds the in-flight promise, so concurrent requests for
// the same directory share one read. Never rejects.
export function loadWorkspace(dir, now = Date.now()) {
  const hit = cache.get(dir);
  if (hit && now - hit.ts < WORKSPACE_TTL_MS) return hit.value;
  if (cache.size >= CACHE_CAP) {
    for (const [k, v] of cache) if (now - v.ts >= WORKSPACE_TTL_MS) cache.delete(k);
  }
  const value = readWorkspace(dir).catch(() => null);
  cache.set(dir, { ts: now, value });
  return value;
}

// The workspace a session in `cwd` belongs to: the nearest ancestor (cwd included) that has
// an active record. A nested checkout with its own features/ but no active record is
// skipped, so a session in <root>/repos/backend still lands on <root>.
export async function findWorkspace(cwd, opts = {}) {
  for (const dir of candidateRoots(cwd, opts)) {
    const ws = await loadWorkspace(dir, opts.now);
    if (ws) return ws;
  }
  return null;
}

// Test seam: drop the cache (fixtures change on disk faster than the TTL).
export function _clearCache() { cache.clear(); }
