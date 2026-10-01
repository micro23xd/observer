// collector.test.mjs — the README acceptance criteria as integration tests.
// Run: node --test   (zero deps; uses node:test + node:assert)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { newSession, buildOverviewRow, STALE_MS } from "./core.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);

function tmpDir(tag) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `hermes-${tag}-`));
}

function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HERMES_")));
}

// Spawn the collector, wait until it logs "listening", return handle.
async function startCollector(env, port) {
  const proc = spawn(process.execPath, [path.join(HERE, "collector.mjs")], {
    // Neutralize the dev's real Vertex creds and any HERMES_* config in the shell (e.g. a
    // HERMES_TOKEN would 401 the open-mode tests) so tests control behavior explicitly;
    // callers re-enable what they need via `env`.
    env: { ...cleanEnv(), GOOGLE_APPLICATION_CREDENTIALS: "", HERMES_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("collector boot timeout:\n" + out)), 8000);
    // Resolve on the LAST boot line so the full banner is captured (no race).
    proc.stdout.on("data", (d) => { out += d; if (out.includes("sessions loaded:")) { clearTimeout(to); resolve(); } });
    proc.stderr.on("data", (d) => { out += d; });
    proc.on("exit", (c) => { clearTimeout(to); reject(new Error(`exited ${c}:\n` + out)); });
  });
  return { proc, port, base: `http://127.0.0.1:${port}`, log: () => out };
}

function stop(h) {
  return new Promise((res) => { h.proc.on("exit", res); h.proc.kill("SIGTERM"); setTimeout(() => { h.proc.kill("SIGKILL"); res(); }, 1500); });
}

const post = (base, body, headers = {}) =>
  fetch(`${base}/events`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The acceptance-criterion-2 sequence.
const SEQ = [
  { hook_event_name: "SessionStart", session_id: "s1", cwd: "/home/dev/acme-api", transcript_path: "/tmp/nope.jsonl" },
  { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "add stripe billing" },
  { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Edit", tool_input: { file_path: "src/billing/stripe.ts" } },
  { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" } },
  { hook_event_name: "PostToolUseFailure", session_id: "s1", tool_name: "Bash", tool_response: { stderr: "fail" } },
  { hook_event_name: "TaskCreated", session_id: "s1", task_id: "task-1", task_subject: "Wire Stripe" },
  { hook_event_name: "TaskCompleted", session_id: "s1", task_id: "task-1" },
];

let H, DIR;
before(async () => {
  DIR = await tmpDir("main");
  H = await startCollector({ HERMES_DATA_DIR: DIR }, 4101); // no token => open
});
after(async () => { await stop(H); await fsp.rm(DIR, { recursive: true, force: true }); });

test("1. boot logs port and summaries flag", () => {
  assert.match(H.log(), /listening on 127\.0\.0\.1:4101/);
  assert.match(H.log(), /summaries: disabled/);
});

test("2. reducer correctness", async () => {
  for (const h of SEQ) { await post(H.base, h); }
  await sleep(150);
  const rows = await (await fetch(`${H.base}/api/sessions`)).json();
  const r = rows.find((x) => x.sessionId === "s1");
  assert.ok(r, "s1 present");
  assert.equal(r.repo, "acme-api");
  assert.equal(r.status, "working");
  assert.equal(r.toolCalls, 2);
  assert.equal(r.edits, 1);
  assert.equal(r.bash, 1);
  assert.equal(r.errors, 1);
  assert.equal(r.fileCount, 1);
  assert.equal(r.tasksOpen, 0);
  assert.equal(r.tasksDone, 1);
  assert.equal(r.attention, true);
});

test("MCP: /mcp tools/list + tools/call list_sessions over JSON-RPC", async () => {
  const rpc = (msg) => fetch(`${H.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) });
  const list = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  assert.equal(list.result.tools.length, 10);
  const call = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_sessions", arguments: {} } })).json();
  const rows = JSON.parse(call.result.content[0].text);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.find((r) => r.sessionId === "s1"), "live s1 visible through MCP");
  // notification gets 202 no-body
  const notif = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notif.status, 202);
});

test("3. attention sort: waiting session sorts at/above non-attention", async () => {
  // s1 is attention (errors). Add s2 (waiting) and s3 (clean idle).
  await post(H.base, { hook_event_name: "SessionStart", session_id: "s3", cwd: "/x/calm" });
  await post(H.base, { hook_event_name: "Stop", session_id: "s3" });
  await post(H.base, { hook_event_name: "SessionStart", session_id: "s2", cwd: "/x/needy" });
  await post(H.base, { hook_event_name: "Notification", session_id: "s2", message: "permission?" });
  await sleep(150);
  const rows = await (await fetch(`${H.base}/api/sessions`)).json();
  const idxAttn = rows.findIndex((r) => r.sessionId === "s2");
  const idxCalm = rows.findIndex((r) => r.sessionId === "s3");
  const s2 = rows[idxAttn];
  assert.equal(s2.status, "waiting");
  assert.equal(s2.attention, true);
  assert.ok(idxAttn < idxCalm, "waiting session sorts above clean idle");
});

test("4. digest: window inclusion/exclusion", async () => {
  const d = await (await fetch(`${H.base}/api/digest?since=30m`)).json();
  assert.ok(typeof d.sinceMs === "number");
  const s1 = d.rows.find((r) => r.sessionId === "s1");
  assert.ok(s1, "recent s1 present in digest");
  assert.equal(s1.edits, 1);
  assert.equal(s1.errors, 1);
  assert.deepEqual(s1.files, ["src/billing/stripe.ts"]);
  assert.deepEqual(s1.commands, ["npm test"]);
  // Tiny window excludes everything (events are older than 1s by now-ish? use sub-second).
  const tiny = await (await fetch(`${H.base}/api/digest?since=0s`)).json();
  assert.equal(tiny.rows.length, 0, "0s window excludes all");
});

test("5. drill-down filter returns only matching kind", async () => {
  const evs = await (await fetch(`${H.base}/api/session/s1/events?types=tool_result`)).json();
  assert.ok(evs.length >= 1);
  assert.ok(evs.every((e) => e.kind === "tool_result"));
  assert.ok(evs.some((e) => e.isError === true));
});

test("9. summary optional: null without Vertex credentials", async () => {
  const r = await (await fetch(`${H.base}/api/session/s1`)).json();
  assert.equal(r.summary, null);
  const s = await (await fetch(`${H.base}/api/session/s1/summarize`, { method: "POST" })).json();
  assert.equal(s.summary, null);
});

test("10. graceful task degradation: no task events => empty rollup", async () => {
  await post(H.base, { hook_event_name: "SessionStart", session_id: "s4", cwd: "/x/notasks" });
  await post(H.base, { hook_event_name: "UserPromptSubmit", session_id: "s4", prompt: "hi" });
  await sleep(120);
  const r = await (await fetch(`${H.base}/api/session/s4`)).json();
  assert.equal(r.tasksOpen, 0);
  assert.equal(r.tasksDone, 0);
  assert.equal(r.currentTask, undefined);
  assert.equal(r.turns, 1);
});

test("attention: stale session is never attention-worthy", () => {
  const now = 10_000_000;
  // Recent idle session that errored => still attention (recent).
  const recent = { ...newSession("r"), status: "idle", lastTs: now - 1000, unresolvedError: true };
  assert.equal(buildOverviewRow(recent, now).attention, true);
  // Same but old enough to be stale => suppressed.
  const old = { ...newSession("o"), status: "idle", lastTs: now - STALE_MS - 1000, unresolvedError: true };
  const row = buildOverviewRow(old, now);
  assert.equal(row.status, "stale");
  assert.equal(row.attention, false);
  // Ended session with an error => suppressed.
  const ended = { ...newSession("e"), status: "ended", lastTs: now - 1000, unresolvedError: true };
  assert.equal(buildOverviewRow(ended, now).attention, false);
});

test("active_only + MCP active_only: param accepted, rows are non-stale", async () => {
  const rest = await (await fetch(`${H.base}/api/sessions?active=1`)).json();
  assert.ok(Array.isArray(rest));
  assert.ok(rest.every((r) => r.status !== "stale" && r.status !== "ended"));
  const mcp = await (await fetch(`${H.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sessions", arguments: { active_only: true } } }) })).json();
  const rows = JSON.parse(mcp.result.content[0].text);
  assert.ok(rows.every((r) => r.status !== "stale" && r.status !== "ended"));
});

test("ignore: hides a repo from sessions + digest, reversible", async () => {
  const before = await (await fetch(`${H.base}/api/sessions`)).json();
  assert.ok(before.find((r) => r.repo === "acme-api"), "s1/acme-api present first");
  // add
  const added = await (await fetch(`${H.base}/api/ignore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ add: ["acme-api"] }) })).json();
  assert.ok(added.ignore.includes("acme-api"));
  const hidden = await (await fetch(`${H.base}/api/sessions`)).json();
  assert.ok(!hidden.find((r) => r.repo === "acme-api"), "ignored repo gone from sessions");
  const dig = await (await fetch(`${H.base}/api/digest?since=2h`)).json();
  assert.ok(!dig.rows.find((r) => r.repo === "acme-api"), "ignored repo gone from digest");
  assert.deepEqual((await (await fetch(`${H.base}/api/ignore`)).json()).ignore.includes("acme-api"), true);
  // remove (cleanup so later tests still see s1)
  const removed = await (await fetch(`${H.base}/api/ignore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ remove: ["acme-api"] }) })).json();
  assert.ok(!removed.ignore.includes("acme-api"));
  const back = await (await fetch(`${H.base}/api/sessions`)).json();
  assert.ok(back.find((r) => r.repo === "acme-api"), "repo returns after un-ignore");
});

test("repo label: live worktree path → repo@branch with no gitBranch sent", async () => {
  // No gitBranch in the hook (as live hooks send); the path carries it.
  await post(H.base, { hook_event_name: "SessionStart", session_id: "wt1", cwd: "/home/dev/.superset/worktrees/web-app/feat/search-v2" });
  await sleep(120);
  const rows = await (await fetch(`${H.base}/api/sessions`)).json();
  const r = rows.find((x) => x.sessionId === "wt1");
  assert.equal(r.repo, "web-app@feat/search-v2");
});

test("repo label: plain checkout → branch filled from .git on disk", async () => {
  const root = await tmpDir("checkout");
  const repo = path.join(root, "web-app");
  await fsp.mkdir(path.join(repo, ".git"), { recursive: true });
  await fsp.writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await fsp.writeFile(path.join(repo, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:acme/web-app.git\n');
  try {
    await post(H.base, { hook_event_name: "SessionStart", session_id: "co1", cwd: repo });
    await sleep(120);
    const rows = await (await fetch(`${H.base}/api/sessions`)).json();
    const r = rows.find((x) => x.sessionId === "co1");
    assert.equal(r.repo, "web-app@main", "branch + origin repo name resolved from disk");
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

// Steering helpers: POST a steer-management call, return parsed JSON + status.
const sapi = async (base, p, body) => {
  const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
// POST a hook event and return the parsed RESPONSE body (which is the hook output).
const hook = async (base, body) => (await post(base, body)).json();

test("steering autonomous: nudge/context/block_tool deliver via /events, one-shot", async () => {
  const dir = await tmpDir("steer-auto");
  // hook delivery is opt-in (default off); this test exercises that channel explicitly.
  const S = await startCollector({ HERMES_DATA_DIR: dir, HERMES_STEERING: "on", HERMES_HOOK_STEERING: "on" }, 4103);
  try {
    await post(S.base, { hook_event_name: "SessionStart", session_id: "k1", cwd: "/x/steerme" });
    await sapi(S.base, "/api/steer/mode", { sessionId: "k1", mode: "autonomous" });

    // nudge auto-arms; the next Stop returns decision:block with the reason + banner.
    const mk = await sapi(S.base, "/api/steer", { sessionId: "k1", kind: "nudge", text: "add error-path tests" });
    assert.equal(mk.json.status, "armed");
    const stop1 = await hook(S.base, { hook_event_name: "Stop", session_id: "k1" });
    assert.equal(stop1.decision, "block");
    assert.match(stop1.reason, /\[Hermes\] add error-path tests/);
    assert.match(stop1.systemMessage, /Hermes steered this session/);
    // one-shot: a second Stop is a plain ack.
    const stop2 = await hook(S.base, { hook_event_name: "Stop", session_id: "k1" });
    assert.deepEqual(stop2, { ok: true });

    // context auto-arms; next UserPromptSubmit injects additionalContext.
    await sapi(S.base, "/api/steer", { sessionId: "k1", kind: "context", text: "prefer fp style" });
    const ups = await hook(S.base, { hook_event_name: "UserPromptSubmit", session_id: "k1", prompt: "go" });
    assert.equal(ups.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(ups.hookSpecificOutput.additionalContext, /\[Hermes\] prefer fp style/);

    // block_tool stays PROPOSED even in autonomous (needs approval); Bash not blocked yet.
    const bt = await sapi(S.base, "/api/steer", { sessionId: "k1", kind: "block_tool", text: "no migrations", tool_match: "Bash" });
    assert.equal(bt.json.status, "proposed");
    const preUnapproved = await hook(S.base, { hook_event_name: "PreToolUse", session_id: "k1", tool_name: "Bash", tool_input: { command: "x" } });
    assert.deepEqual(preUnapproved, { ok: true }, "unapproved block_tool does not fire");
    // approve, then a non-matching tool passes but Bash is denied.
    await sapi(S.base, `/api/steer/${bt.json.id}/approve`, {});
    const preEdit = await hook(S.base, { hook_event_name: "PreToolUse", session_id: "k1", tool_name: "Edit", tool_input: {} });
    assert.deepEqual(preEdit, { ok: true }, "tool_match=Bash leaves Edit alone");
    const preBash = await hook(S.base, { hook_event_name: "PreToolUse", session_id: "k1", tool_name: "Bash", tool_input: { command: "rails db:migrate" } });
    assert.equal(preBash.hookSpecificOutput.permissionDecision, "deny");
    assert.match(preBash.hookSpecificOutput.permissionDecisionReason, /no migrations/);

    // audit log captured the lifecycle.
    const audit = await fsp.readFile(path.join(dir, "steer.jsonl"), "utf8");
    assert.match(audit, /"ev":"create"/);
    assert.match(audit, /"ev":"deliver"/);
    assert.match(audit, /"ev":"arm"/);
  } finally { await stop(S); await fsp.rm(dir, { recursive: true, force: true }); }
});

test("steering approval + master switch gate delivery", async () => {
  const dir = await tmpDir("steer-appr");
  const S = await startCollector({ HERMES_DATA_DIR: dir, HERMES_STEERING: "on", HERMES_HOOK_STEERING: "on" }, 4104);
  try {
    await post(S.base, { hook_event_name: "SessionStart", session_id: "a1", cwd: "/x/appr" });
    await sapi(S.base, "/api/steer/mode", { sessionId: "a1", mode: "approval" });

    // Approval mode: directive is proposed and does NOT deliver until approved.
    const mk = await sapi(S.base, "/api/steer", { sessionId: "a1", kind: "nudge", text: "run the linter" });
    assert.equal(mk.json.status, "proposed");
    const before = await hook(S.base, { hook_event_name: "Stop", session_id: "a1" });
    assert.deepEqual(before, { ok: true }, "proposed directive does not deliver");
    await sapi(S.base, `/api/steer/${mk.json.id}/approve`, {});
    const after = await hook(S.base, { hook_event_name: "Stop", session_id: "a1" });
    assert.equal(after.decision, "block");
    assert.match(after.reason, /run the linter/);

    // Master switch off: creation is rejected and nothing delivers.
    await sapi(S.base, "/api/steer/master", { enabled: false });
    const rejected = await sapi(S.base, "/api/steer", { sessionId: "a1", kind: "nudge", text: "x" });
    assert.equal(rejected.status, 400);
    assert.match(rejected.json.error, /disabled/);
    // Re-arm path is irrelevant; even an already-armed one can't deliver with master off:
    await sapi(S.base, "/api/steer/master", { enabled: true });
    const mk2 = await sapi(S.base, "/api/steer", { sessionId: "a1", kind: "nudge", text: "armed then disabled" });
    await sapi(S.base, `/api/steer/${mk2.json.id}/approve`, {});
    await sapi(S.base, "/api/steer/master", { enabled: false });
    const masterOff = await hook(S.base, { hook_event_name: "Stop", session_id: "a1" });
    assert.deepEqual(masterOff, { ok: true }, "master off suppresses delivery of an armed directive");

    // A non-steerable session (mode off) rejects creation even with master on.
    await sapi(S.base, "/api/steer/master", { enabled: true });
    await post(S.base, { hook_event_name: "SessionStart", session_id: "off1", cwd: "/x/off" });
    const offReject = await sapi(S.base, "/api/steer", { sessionId: "off1", kind: "nudge", text: "x" });
    assert.equal(offReject.status, 400);
    assert.match(offReject.json.error, /not steerable/);
  } finally { await stop(S); await fsp.rm(dir, { recursive: true, force: true }); }
});

test("steering MCP write tools: steer_session + list_steers + cancel_steer over /mcp", async () => {
  const dir = await tmpDir("steer-mcp");
  const S = await startCollector({ HERMES_DATA_DIR: dir, HERMES_STEERING: "on", HERMES_STEER_DEFAULT_MODE: "autonomous" }, 4105);
  try {
    await post(S.base, { hook_event_name: "SessionStart", session_id: "m1", cwd: "/x/mcpsteer" });
    const rpc = async (msg) => (await fetch(`${S.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) })).json();
    const call = (name, args) => rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

    const made = JSON.parse((await call("steer_session", { session_id: "m1", kind: "nudge", text: "ship it" })).result.content[0].text);
    assert.equal(made.status, "armed");
    const listed = JSON.parse((await call("list_steers", { session_id: "m1" })).result.content[0].text);
    assert.ok(listed.find((d) => d.id === made.id));
    const cancelled = JSON.parse((await call("cancel_steer", { id: made.id })).result.content[0].text);
    assert.equal(cancelled.status, "cancelled");
    // Cancelled directive does not deliver.
    const stop = await hook(S.base, { hook_event_name: "Stop", session_id: "m1" });
    assert.deepEqual(stop, { ok: true });
  } finally { await stop(S); await fsp.rm(dir, { recursive: true, force: true }); }
});

test("6. auth: bearer required for non-loopback model (token set)", async () => {
  const dir = await tmpDir("auth");
  const A = await startCollector({ HERMES_DATA_DIR: dir, HERMES_TOKEN: "secret" }, 4102);
  try {
    const noTok = await fetch(`${A.base}/api/sessions`);
    assert.equal(noTok.status, 401, "no token => 401");
    const badTok = await fetch(`${A.base}/api/sessions`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(badTok.status, 401, "wrong token => 401");
    const okTok = await fetch(`${A.base}/api/sessions`, { headers: { authorization: "Bearer secret" } });
    assert.equal(okTok.status, 200, "right token => 200");
    const dash = await fetch(`${A.base}/`);
    assert.equal(dash.status, 200, "dashboard works without token");
    const mcpNoTok = await fetch(`${A.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(mcpNoTok.status, 401, "/mcp requires bearer when token set");
    const mcpTok = await fetch(`${A.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(mcpTok.status, 200, "/mcp works with bearer");
    // /events is bearer-gated too: a spoofed hook from an unauthenticated tailnet
    // peer must be rejected. Local hooks send the token via their `headers` config.
    const evNoTok = await post(A.base, { hook_event_name: "SessionStart", session_id: "z", cwd: "/z" });
    assert.equal(evNoTok.status, 401, "/events requires bearer when token set");
    const evTok = await post(A.base, { hook_event_name: "SessionStart", session_id: "z", cwd: "/z" }, { authorization: "Bearer secret" });
    assert.equal(evTok.status, 200, "/events ingests with the bearer");
  } finally { await stop(A); await fsp.rm(dir, { recursive: true, force: true }); }
});

test("unauthenticated /events cannot consume an armed steering directive", async () => {
  const dir = await tmpDir("c1");
  // Token set AND steering on: this is the production posture an attacker faces.
  const S = await startCollector({ HERMES_DATA_DIR: dir, HERMES_TOKEN: "sek", HERMES_STEERING: "on", HERMES_HOOK_STEERING: "on" }, 4106);
  const auth = { authorization: "Bearer sek" };
  try {
    await post(S.base, { hook_event_name: "SessionStart", session_id: "v1", cwd: "/x/victim" }, auth);
    await fetch(`${S.base}/api/steer/mode`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ sessionId: "v1", mode: "autonomous" }) });
    const mk = await (await fetch(`${S.base}/api/steer`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ sessionId: "v1", kind: "nudge", text: "secret directive" }) })).json();
    assert.equal(mk.status, "armed");

    // Attacker (no token) spoofs the victim's Stop hook: must be rejected, NOT served the
    // directive — so it can neither consume (one-shot) nor read the directive text.
    const spoof = await post(S.base, { hook_event_name: "Stop", session_id: "v1" });
    assert.equal(spoof.status, 401, "spoofed /events rejected");
    const spoofBody = await spoof.text();
    assert.ok(!spoofBody.includes("secret directive"), "directive text not leaked to attacker");

    // The legitimate (authenticated) Stop hook still receives the directive, intact.
    const real = await (await post(S.base, { hook_event_name: "Stop", session_id: "v1" }, auth)).json();
    assert.equal(real.decision, "block");
    assert.match(real.reason, /secret directive/);
  } finally { await stop(S); await fsp.rm(dir, { recursive: true, force: true }); }
});

test("REST /api/steer ignores client-supplied `by` (audit attribution unforgeable)", async () => {
  const dir = await tmpDir("by");
  const S = await startCollector({ HERMES_DATA_DIR: dir, HERMES_STEERING: "on", HERMES_STEER_DEFAULT_MODE: "autonomous" }, 4107);
  try {
    await post(S.base, { hook_event_name: "SessionStart", session_id: "b1", cwd: "/x/by" });
    // Forge `by: "hermes"` in the REST body; the server must record "operator" instead.
    const mk = await sapi(S.base, "/api/steer", { sessionId: "b1", kind: "nudge", text: "audit me", by: "hermes" });
    assert.equal(mk.status, 200);
    const audit = (await fsp.readFile(path.join(dir, "steer.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const create = audit.find((e) => e.ev === "create" && e.id === mk.json.id);
    assert.ok(create, "create entry present");
    assert.equal(create.by, "operator", "forged `by` ignored — attributed to the auth channel");
  } finally { await stop(S); await fsp.rm(dir, { recursive: true, force: true }); }
});

test("7. timeout safety: connecting to a dead collector fails fast", async () => {
  const t0 = Date.now();
  await assert.rejects(fetch("http://127.0.0.1:4199/events", { method: "POST", body: "{}" }));
  assert.ok(Date.now() - t0 < 2000, "connection refused returns quickly (non-blocking)");
});

test("8. importer populates state.json", async () => {
  const dir = await tmpDir("imp");
  const cdir = await tmpDir("claude");
  const proj = path.join(cdir, "encoded-cwd");
  await fsp.mkdir(proj, { recursive: true });
  const sid = "imp-session-1";
  const lines = [
    { type: "summary", summary: "Imported session title", sessionId: sid, timestamp: "2026-05-30T10:00:00Z" },
    { type: "user", sessionId: sid, cwd: "/home/dev/imported-repo", gitBranch: "feat/x", timestamp: "2026-05-30T10:00:01Z", message: { content: [{ type: "text", text: "do the thing" }] } },
    { type: "assistant", sessionId: sid, cwd: "/home/dev/imported-repo", timestamp: "2026-05-30T10:00:02Z", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "a/b.ts" } }] } },
    { type: "assistant", sessionId: sid, cwd: "/home/dev/imported-repo", timestamp: "2026-05-30T10:00:03Z", message: { content: [{ type: "tool_use", name: "TaskCreate", input: { taskId: "t9", subject: "do work" } }] } },
    { type: "assistant", sessionId: sid, cwd: "/home/dev/imported-repo", timestamp: "2026-05-30T10:00:04Z", message: { content: [{ type: "tool_use", name: "TaskUpdate", input: { taskId: "t9", status: "completed" } }] } },
  ];
  await fsp.writeFile(path.join(proj, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));

  await new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(HERE, "import-claude.mjs")], {
      env: { ...cleanEnv(), CLAUDE_DIR: cdir, HERMES_DATA_DIR: dir }, stdio: "inherit",
    });
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error("import exit " + c))));
  });

  const state = JSON.parse(await fsp.readFile(path.join(dir, "state.json"), "utf8"));
  const s = state[sid];
  assert.ok(s, "imported session in state.json");
  assert.equal(s.repo, "imported-repo@feat/x");
  assert.equal(s.title, "Imported session title");
  assert.equal(s.status, "idle", "active import downgraded to idle");
  assert.equal(s.edits, 1);
  assert.equal(s.tasksDone, 1);
  assert.ok(fs.existsSync(path.join(dir, "state.json")));
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(cdir, { recursive: true, force: true });
});

// ── Idle steering via tmux send-keys ─────────────────────────────────────────
// End-to-end: a Superset launch wrapper would register a tmux target for a session;
// when that session is idle and an armed directive exists, the collector types it into
// the terminal. We stand in for claude with a tiny prompt-echo program in a real tmux
// session and assert the directive text lands. Skipped where tmux isn't installed.

const HAS_TMUX = spawnSync("tmux", ["-V"]).status === 0;
const TSOCK = `hermestest-${process.pid}`;
const tmuxq = (...a) => execFileSync("tmux", ["-L", TSOCK, ...a], { encoding: "utf8" });

test("idle steering: an armed directive is typed into an idle session via tmux", { skip: HAS_TMUX ? false : "tmux not installed" }, async () => {
  const dir = await tmpDir("tmux");
  const h = await startCollector(
    { HERMES_DATA_DIR: dir, HERMES_STEERING: "on", HERMES_STEER_DEFAULT_MODE: "autonomous" },
    4131,
  );
  const cwd = path.join(os.tmpdir(), `hermes-tmux-cwd-${process.pid}`);
  const target = "standin";
  // Stand-in TUI: prints an empty "❯ " prompt, echoes each submitted line as GOT:<line>.
  const PROG = `printf '%s' '❯ '; while IFS= read -r line; do printf '\\nGOT:%s\\n%s' "$line" '❯ '; done`;
  try { tmuxq("kill-server"); } catch { /* none yet */ }
  tmuxq("new-session", "-d", "-s", target, "-x", "100", "-y", "24", "--", "sh", "-c", PROG);

  try {
    // 1) Session exists (carries cwd). 2) Wrapper registers its tmux target. 3) It goes idle.
    await post(h.base, { hook_event_name: "SessionStart", session_id: "tx", cwd });
    const reg = await fetch(`${h.base}/api/steer/pane`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, server: TSOCK, target }),
    });
    assert.equal(reg.status, 200, "pane registered");
    await post(h.base, { hook_event_name: "Stop", session_id: "tx" }); // → status idle
    await sleep(150);

    // 4) Queue a context directive — autonomous mode auto-arms it, which triggers delivery.
    const q = await fetch(`${h.base}/api/steer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "tx", kind: "context", text: "follow the existing util" }),
    });
    const created = await q.json();
    assert.equal(created.status, "armed", "context auto-arms in autonomous mode");

    // 5) The stand-in should have received the typed, [Hermes]-prefixed prompt.
    await sleep(700);
    const pane = tmuxq("capture-pane", "-p", "-t", target);
    assert.match(pane, /GOT:\[Hermes\] follow the existing util/, "directive typed into idle session");

    // 6) And the directive is recorded delivered via tmux.
    const snap = await (await fetch(`${h.base}/api/steer`)).json();
    const d = snap.directives.find((x) => x.id === created.id);
    assert.equal(d.status, "delivered");
    assert.equal(d.deliveredVia, "tmux");

    // 7) The overview row advertises idle-steerability (live pane → canSteer).
    const rows = await (await fetch(`${h.base}/api/sessions`)).json();
    const st = rows.find((r) => r.sessionId === "tx").steer;
    assert.equal(st.reach, "live-pane");
    assert.equal(st.pane, true);
    assert.equal(st.canSteer, true);
  } finally {
    try { tmuxq("kill-server"); } catch { /* already gone */ }
    await stop(h);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});

// ── Control grants: explicit, operator-only consent for autonomous idle steering ──
// The end-state safety property: Hermes can REQUEST control (MCP) but can never GRANT it;
// only the operator (REST) can. Before a grant the session is unsteerable; after, Hermes's
// nudges auto-arm and land in the idle pane; revoke ends it. Skipped without tmux.

test("control grant: request → operator grant → idle delivery; MCP cannot self-grant; revoke ends it",
  { skip: HAS_TMUX ? false : "tmux not installed" }, async () => {
  const dir = await tmpDir("ctl");
  // master ON, default mode OFF — so the ONLY way to steer is an explicit control grant.
  const h = await startCollector({ HERMES_DATA_DIR: dir, HERMES_STEERING: "on" }, 4133);
  const cwd = path.join(os.tmpdir(), `hermes-ctl-cwd-${process.pid}`);
  const target = "ctlstandin";
  const TS = `hermesctl-${process.pid}`;
  const tq = (...a) => execFileSync("tmux", ["-L", TS, ...a], { encoding: "utf8" });
  const PROG = `printf '%s' '❯ '; while IFS= read -r line; do printf '\\nGOT:%s\\n%s' "$line" '❯ '; done`;
  const rpc = (msg) => fetch(`${h.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) }).then((r) => r.json());
  const callTool = async (name, args) => {
    const r = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });
    return r.result;
  };
  try { tq("kill-server"); } catch { /* none */ }
  tq("new-session", "-d", "-s", target, "-x", "100", "-y", "24", "--", "sh", "-c", PROG);

  try {
    // Idle session with a pane, but mode off → not steerable yet.
    await post(h.base, { hook_event_name: "SessionStart", session_id: "cx", cwd });
    await fetch(`${h.base}/api/steer/pane`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, server: TS, target }) });
    await post(h.base, { hook_event_name: "Stop", session_id: "cx" });
    await sleep(120);

    // The consent boundary: MCP exposes request/release but NO grant/approve tool.
    const tools = (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t) => t.name);
    assert.ok(tools.includes("request_control") && tools.includes("release_control"));
    assert.ok(!tools.some((n) => /grant|approve|set_mode|master/.test(n)), "MCP has no grant/approve/master tool");

    // Hermes requests control → 'requested', NOT active.
    const req = JSON.parse((await callTool("request_control", { session_id: "cx", task: "finish the migration" })).content[0].text);
    assert.equal(req.status, "requested");

    // Before a grant, steering is refused (the session is still off).
    assert.equal((await callTool("steer_session", { session_id: "cx", kind: "nudge", text: "x" })).isError, true);

    // Shows as pending in snapshot + per-row status.
    assert.equal((await (await fetch(`${h.base}/api/steer`)).json()).pendingControl, 1);
    let row = (await (await fetch(`${h.base}/api/sessions`)).json()).find((r) => r.sessionId === "cx");
    assert.equal(row.steer.pendingControl, true);
    assert.equal(row.steer.controlled, false);

    // Operator grants (REST only) → control becomes active.
    const g = await (await fetch(`${h.base}/api/control/${req.id}/grant`, { method: "POST" })).json();
    assert.equal(g.status, "granted");

    // Now Hermes's nudge auto-arms (granted ⇒ autonomous) and is typed into the idle pane.
    const created = JSON.parse((await callTool("steer_session", { session_id: "cx", kind: "nudge", text: "run the tests" })).content[0].text);
    assert.equal(created.status, "armed");
    await sleep(700);
    assert.match(tq("capture-pane", "-p", "-t", target), /GOT:\[Hermes\] run the tests/, "directive typed under grant");

    // Row reflects controlled + truly steerable; session detail carries control summary.
    row = (await (await fetch(`${h.base}/api/sessions`)).json()).find((r) => r.sessionId === "cx");
    assert.equal(row.steer.controlled, true);
    assert.equal(row.steer.permission, "controlled");
    assert.equal(row.steer.canSteer, true);
    assert.equal((await (await fetch(`${h.base}/api/session/cx`)).json()).control.status, "granted");

    // Operator revokes → control ends → steering refused again.
    await fetch(`${h.base}/api/control/${req.id}/revoke`, { method: "POST" });
    assert.equal((await callTool("steer_session", { session_id: "cx", kind: "nudge", text: "y" })).isError, true, "revoke ends control");
  } finally {
    try { tq("kill-server"); } catch { /* gone */ }
    await stop(h);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});

// ── hook steering off by default (idle-pane is the preferred channel) ──
test("hook steering OFF by default: nudge/context skip the hook; block_tool still fires; runtime toggle restores it", async () => {
  const dir = await tmpDir("nohook");
  const S = await startCollector({ HERMES_DATA_DIR: dir, HERMES_STEERING: "on", HERMES_STEER_DEFAULT_MODE: "autonomous" }, 4108);
  try {
    await post(S.base, { hook_event_name: "SessionStart", session_id: "h1", cwd: "/x/nohook" });
    assert.equal((await (await fetch(`${S.base}/api/steer`)).json()).hookSteering, false, "default off");

    // nudge auto-arms but does NOT ride the Stop hook (would, if hook delivery were on).
    await sapi(S.base, "/api/steer", { sessionId: "h1", kind: "nudge", text: "finish later" });
    assert.deepEqual(await hook(S.base, { hook_event_name: "Stop", session_id: "h1" }), { ok: true });
    // context likewise does not inject into UserPromptSubmit.
    await sapi(S.base, "/api/steer", { sessionId: "h1", kind: "context", text: "soft hint" });
    assert.deepEqual(await hook(S.base, { hook_event_name: "UserPromptSubmit", session_id: "h1", prompt: "go" }), { ok: true });

    // block_tool is exempt — a real-time deny has no idle-pane equivalent, so it still fires.
    const bt = await sapi(S.base, "/api/steer", { sessionId: "h1", kind: "block_tool", text: "no migrations", tool_match: "Bash" });
    await sapi(S.base, `/api/steer/${bt.json.id}/approve`, {});
    const pre = await hook(S.base, { hook_event_name: "PreToolUse", session_id: "h1", tool_name: "Bash", tool_input: { command: "x" } });
    assert.equal(pre.hookSpecificOutput.permissionDecision, "deny", "block_tool fires even with hook steering off");

    // Flip hook delivery on at runtime → the still-armed nudge now delivers on the next Stop.
    await sapi(S.base, "/api/steer/config", { hookSteering: true });
    const stop2 = await hook(S.base, { hook_event_name: "Stop", session_id: "h1" });
    assert.equal(stop2.decision, "block");
    assert.match(stop2.reason, /finish later/);
  } finally { await stop(S); await fsp.rm(dir, { recursive: true, force: true }); }
});

// ── pane registration robustness (token file + cwd-collision ownership) ──
test("collector writes a 0600 token file for the launch wrapper when HERMES_TOKEN is set", async () => {
  const dir = await tmpDir("tokfile");
  const S = await startCollector({ HERMES_DATA_DIR: dir, HERMES_TOKEN: "abc123" }, 4110);
  try {
    const tf = path.join(dir, "token");
    assert.equal(await fsp.readFile(tf, "utf8"), "abc123");
    assert.equal((await fsp.stat(tf)).mode & 0o777, 0o600, "token file is 0600");
  } finally { await stop(S); await fsp.rm(dir, { recursive: true, force: true }); }
});

test("pane registration: cwd collision attaches only to the newest LIVE session", async () => {
  const dir = await tmpDir("panecwd");
  const S = await startCollector({ HERMES_DATA_DIR: dir }, 4111);
  try {
    const cwd = "/x/sharedcwd"; // a plain checkout reused across runs (repo@main)
    await post(S.base, { hook_event_name: "SessionStart", session_id: "old", cwd });
    await post(S.base, { hook_event_name: "SessionEnd", session_id: "old" });       // ended
    await post(S.base, { hook_event_name: "SessionStart", session_id: "live", cwd });
    await post(S.base, { hook_event_name: "Stop", session_id: "live" });            // idle, live
    await sleep(80);
    await fetch(`${S.base}/api/steer/pane`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, server: "hsrv", target: "tgt" }) });
    await sleep(50);
    const byId = Object.fromEntries((await (await fetch(`${S.base}/api/sessions`)).json()).map((r) => [r.sessionId, r]));
    assert.equal(byId["live"].steer.pane, true, "newest live session owns the pane");
    assert.equal(byId["old"].steer.pane, false, "ended session never owns the pane");
  } finally { await stop(S); await fsp.rm(dir, { recursive: true, force: true }); }
});

test("boot does not trust a persisted tmux pane (stale 🖥 never resurrects)", async () => {
  const dir = await tmpDir("staletmux");
  // Simulate a state.json written by an older build that persisted `tmux`.
  await fsp.writeFile(path.join(dir, "state.json"), JSON.stringify({
    z9: { ...newSession("z9"), cwd: "/x/z", status: "idle", lastTs: 1, tmux: { server: "hermes", target: "dead-pane" } },
  }));
  const S = await startCollector({ HERMES_DATA_DIR: dir }, 4112);
  try {
    const row = (await (await fetch(`${S.base}/api/sessions`)).json()).find((r) => r.sessionId === "z9");
    assert.ok(row, "loaded the persisted session");
    assert.equal(row.steer.pane, false, "persisted tmux is dropped on load");
  } finally { await stop(S); await fsp.rm(dir, { recursive: true, force: true }); }
});

test("steer vocabulary: permitted but no live pane → reach=unreachable, canSteer=false with why; directive still queues", async () => {
  const dir = await tmpDir("reach");
  const S = await startCollector({ HERMES_DATA_DIR: dir, HERMES_STEERING: "on", HERMES_STEER_DEFAULT_MODE: "autonomous" }, 4113);
  try {
    await post(S.base, { hook_event_name: "SessionStart", session_id: "r1", cwd: "/x/nopane" });
    await post(S.base, { hook_event_name: "Stop", session_id: "r1" }); // idle, no pane, hookSteering off
    await sleep(80);
    const st = (await (await fetch(`${S.base}/api/sessions`)).json()).find((r) => r.sessionId === "r1").steer;
    assert.equal(st.permission, "autonomous");          // permitted
    assert.equal(st.reach, "unreachable");               // …but not reachable (no pane, idle)
    assert.equal(st.canSteer, false);
    assert.match(st.why, /no live pane/);
    // The directive still queues (armed) — not lost — and the MCP return is explicit about it.
    const rpc = async (m) => (await fetch(`${S.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(m) })).json();
    const r = JSON.parse((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "steer_session", arguments: { session_id: "r1", kind: "nudge", text: "later" } } })).result.content[0].text);
    assert.equal(r.status, "armed");
    assert.equal(r.reach, "unreachable");
    assert.equal(r.willDeliver, false);
    assert.match(r.note, /not deliverable yet/);
  } finally { await stop(S); await fsp.rm(dir, { recursive: true, force: true }); }
});

// ── decision-prompt steering: answer a plan approval via a `decide` directive ──
test("decide: ExitPlanMode prompt is answered via tmux; a nudge is NOT typed into the menu",
  { skip: HAS_TMUX ? false : "tmux not installed" }, async () => {
  const dir = await tmpDir("decide");
  const S = await startCollector({ HERMES_DATA_DIR: dir, HERMES_STEERING: "on", HERMES_STEER_DEFAULT_MODE: "autonomous" }, 4114);
  const cwd = path.join(os.tmpdir(), `hermes-decide-cwd-${process.pid}`);
  const target = "decstandin";
  const TS = `hermesdec-${process.pid}`;
  const tq = (...a) => execFileSync("tmux", ["-L", TS, ...a], { encoding: "utf8" });
  // Stand-in: paints a plan-approval menu, then echoes the picked line.
  const PROG = `printf '%s\\n%s\\n' '❯ 1. Yes, proceed' '  2. No, keep planning'; while IFS= read -r x; do printf 'PICKED:%s\\n' "$x"; done`;
  const rpc = async (m) => (await fetch(`${S.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(m) })).json();
  const callTool = async (n, a) => (await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: n, arguments: a } })).result;
  try { tq("kill-server"); } catch { /* none */ }
  tq("new-session", "-d", "-s", target, "-x", "100", "-y", "24", "--", "sh", "-c", PROG);

  try {
    await post(S.base, { hook_event_name: "SessionStart", session_id: "p1", cwd });
    await fetch(`${S.base}/api/steer/pane`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, server: TS, target }) });
    // Agent calls ExitPlanMode → blocks for approval (status waiting, awaitingDecision=plan).
    await post(S.base, { hook_event_name: "PreToolUse", session_id: "p1", tool_name: "ExitPlanMode", tool_input: { plan: "do the thing" } });
    await sleep(120);

    let st = (await (await fetch(`${S.base}/api/sessions`)).json()).find((r) => r.sessionId === "p1").steer;
    assert.equal(st.awaitingDecision, "plan");
    assert.equal(st.reach, "live-pane");
    assert.equal(st.deliverWhen, "now");

    // A nudge must NOT be typed into the menu (only `decide` is eligible while deciding).
    const nudge = JSON.parse((await callTool("steer_session", { session_id: "p1", kind: "nudge", text: "hello there" })).content[0].text);
    assert.equal(nudge.status, "armed");
    await sleep(500);
    assert.doesNotMatch(tq("capture-pane", "-p", "-t", target), /hello there/, "free message not typed into a decision menu");

    // A decide 'accept' → maps to option 1 → typed and selected.
    const dec = JSON.parse((await callTool("steer_session", { session_id: "p1", kind: "decide", text: "accept" })).content[0].text);
    assert.equal(dec.status, "armed");
    await sleep(800);
    assert.match(tq("capture-pane", "-p", "-t", target), /PICKED:1/, "decide accept selected option 1");
  } finally {
    try { tq("kill-server"); } catch { /* gone */ }
    await stop(S);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});
