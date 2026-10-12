// features.test.mjs — offline tests for feature records: sanitising untrusted status.json,
// cwd → workspace matching (fabricated .git layouts on disk, no real `git` needed), the
// default steering target, and the needs-the-operator sort.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  sanitizeRecord, parseRecord, candidateRoots, activeRecords, pickSteerTarget, sortFeatures,
  buildFeatures, findWorkspace, loadWorkspace, _clearCache,
  MAX_RECORD_BYTES, MAX_WALK_DEPTH, WORKSPACE_TTL_MS,
} from "./features.mjs";

const tmp = (tag) => fsp.mkdtemp(path.join(os.tmpdir(), `features-${tag}-`));

// The README example record, verbatim.
const EXAMPLE = {
  feature: "chat-stop-button",
  title: "Stop button for chat",
  mode: "hands-off",
  branch: "chat-stop-button",
  stage: "building",
  now: "Backend: endpoint",
  waiting: { question: "Soft delete or hard delete?", options: ["Soft delete", "Hard delete"], recommendation: "Soft delete", since: "2026-10-11T21:49:11.513Z" },
  verified: [{ what: "List shows items", evidence: "evidence/01-list.png", at: "2026-10-11T21:49:11.513Z" }],
  prs: [{ repo: "backend", url: "https://github.com/acme/backend/pull/999" }],
  actions: [{ label: "Verify", text: "Run the feature-verify skill for this feature." }],
  created: "2026-10-11T21:49:11.331Z",
  updated: "2026-10-11T21:49:11.575Z",
};

// Fabricate a workspace root: a `.git` dir on `branch` plus features/<slug>/status.json.
async function makeRoot(root, branch, records = {}) {
  await fsp.mkdir(path.join(root, ".git"), { recursive: true });
  await fsp.writeFile(path.join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  for (const [slug, body] of Object.entries(records)) {
    await fsp.mkdir(path.join(root, "features", slug), { recursive: true });
    await fsp.writeFile(path.join(root, "features", slug, "status.json"), typeof body === "string" ? body : JSON.stringify(body));
  }
}

// ── sanitising ──

test("sanitizeRecord: a well-formed record passes through unchanged", () => {
  assert.deepEqual(sanitizeRecord(EXAMPLE), EXAMPLE);
});

test("sanitizeRecord: only feature + branch are required; the rest defaults to empty", () => {
  assert.deepEqual(sanitizeRecord({ feature: "f", branch: "b" }),
    { feature: "f", branch: "b", waiting: null, verified: [], prs: [], actions: [] });
});

test("sanitizeRecord: not a record → null (wrong shape, missing/invalid required fields)", () => {
  for (const bad of [null, undefined, 42, "str", [], [EXAMPLE], {}, { feature: "f" }, { branch: "b" },
    { feature: 7, branch: "b" }, { feature: "f", branch: ["b"] }, { feature: "   ", branch: "b" },
    { feature: "f", branch: "x".repeat(300) }, { feature: "x".repeat(200), branch: "b" }]) {
    assert.equal(sanitizeRecord(bad), null, JSON.stringify(bad));
  }
});

test("sanitizeRecord: wrong-typed optional fields are dropped, the record survives", () => {
  const r = sanitizeRecord({
    feature: "f", branch: "b",
    title: { html: "<b>" }, mode: 3, stage: ["building"], now: null,
    waiting: "yes", verified: "all of it", prs: { url: "https://x.test" }, actions: 5,
    created: 1760000000000, updated: "not a date",
  });
  assert.deepEqual(r, { feature: "f", branch: "b", waiting: null, verified: [], prs: [], actions: [] });
});

test("sanitizeRecord: unexpected fields never reach the output (whitelist)", () => {
  const r = sanitizeRecord(JSON.parse('{"feature":"f","branch":"b","__proto__":{"polluted":true},"extra":"x","sessions":[1],"root":"/etc","targetSessionId":"s9","waiting":{"question":"q","evil":"<script>"},"actions":[{"label":"L","text":"T","kind":"block_tool","sessionId":"other"}]}'));
  assert.deepEqual(Object.keys(r).sort(), ["actions", "branch", "feature", "prs", "verified", "waiting"]);
  assert.deepEqual(r.waiting, { question: "q", options: [] });
  assert.deepEqual(r.actions, [{ label: "L", text: "T" }]);
  assert.equal({}.polluted, undefined);
});

test("sanitizeRecord: waiting needs a question; options are filtered and capped", () => {
  const base = { feature: "f", branch: "b" };
  assert.equal(sanitizeRecord({ ...base, waiting: null }).waiting, null);
  assert.equal(sanitizeRecord({ ...base, waiting: {} }).waiting, null);
  assert.equal(sanitizeRecord({ ...base, waiting: { options: ["a"] } }).waiting, null);
  assert.equal(sanitizeRecord({ ...base, waiting: ["q"] }).waiting, null);
  const w = sanitizeRecord({ ...base, waiting: { question: "Which?", options: ["a", 2, null, { x: 1 }, "b", ...Array(20).fill("more")], recommendation: 9, since: "nope" } }).waiting;
  assert.equal(w.question, "Which?");
  assert.equal(w.options.length, 8, "capped");
  assert.deepEqual(w.options.slice(0, 3), ["a", "b", "more"], "non-strings dropped");
  assert.ok(!("recommendation" in w) && !("since" in w));
});

test("sanitizeRecord: prs keep only credential-free https:// URLs", () => {
  const r = sanitizeRecord({ feature: "f", branch: "b", prs: [
    { repo: "ok", url: "https://github.com/acme/backend/pull/1" },
    { repo: "js", url: "javascript:alert(1)" },
    { repo: "http", url: "http://github.com/acme/backend/pull/2" },
    { repo: "data", url: "data:text/html,<script>alert(1)</script>" },
    { repo: "creds", url: "https://user:pw@evil.test/" },
    { repo: "rel", url: "/pull/3" },
    { repo: "num", url: 12 },
    { repo: "upper", url: "  HTTPS://Example.test/a\"b<c  " },
    "https://bare.string/",
  ] });
  assert.deepEqual(r.prs.map((p) => p.repo), ["ok", "upper"]);
  assert.equal(r.prs[0].url, "https://github.com/acme/backend/pull/1");
  assert.ok(r.prs[1].url.startsWith("https://example.test/"), "normalised by the URL parser");
  assert.ok(!/["<>\s]/.test(r.prs[1].url), "no raw quote/angle/space survives in a URL");
});

test("sanitizeRecord: actions need label + text; an over-long instruction is dropped, never truncated", () => {
  const r = sanitizeRecord({ feature: "f", branch: "b", actions: [
    { label: "Verify", text: "Run the verify skill." },
    { label: "No text" },
    { text: "no label" },
    { label: "Too long", text: "x".repeat(2001) },
    { label: "L".repeat(100), text: "ok" },
    "Verify",
    ...Array(20).fill({ label: "more", text: "more" }),
  ] });
  assert.equal(r.actions.length, 8, "capped");
  assert.deepEqual(r.actions[0], { label: "Verify", text: "Run the verify skill." });
  assert.equal(r.actions[1].label.length, 40, "display label shortened");
  assert.ok(r.actions[1].label.endsWith("…"));
  assert.equal(r.actions[1].text, "ok");
  assert.ok(r.actions.every((a) => a.label !== "Too long"));
});

test("sanitizeRecord: control characters are flattened (an instruction is typed into a terminal)", () => {
  const r = sanitizeRecord({
    feature: "f", branch: "b", title: "line one\nline two\ttabbed\u001b[31m",
    actions: [{ label: "Go", text: "first\r\nrm -rf /\u0000\u001b]0;x\u0007 second\u2028third" }],
  });
  assert.equal(r.title, "line one line two tabbed [31m");
  assert.equal(r.actions[0].text, "first rm -rf / ]0;x second third");
  for (const s of [r.title, r.actions[0].text]) assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s), "no control chars left");
});

test("sanitizeRecord: long display text is shortened; timestamps are normalised or dropped", () => {
  const r = sanitizeRecord({ feature: "f", branch: "b", title: "t".repeat(5000), now: "n".repeat(5000),
    created: "2026-10-11T21:49:11.331Z", updated: "2026-10-11 21:49:11Z",
    verified: [{ what: "w", at: "garbage" }, { evidence: "no what" }, 3, { what: "x".repeat(900), evidence: "e.png", at: "2026-10-11T00:00:00Z" }] });
  assert.equal(r.title.length, 200);
  assert.equal(r.now.length, 300);
  assert.equal(r.created, "2026-10-11T21:49:11.331Z");
  assert.equal(r.updated, "2026-10-11T21:49:11.000Z");
  assert.deepEqual(r.verified[0], { what: "w" });
  assert.equal(r.verified.length, 2);
  assert.equal(r.verified[1].what.length, 300);
  assert.equal(r.verified[1].at, "2026-10-11T00:00:00.000Z");
});

test("parseRecord: malformed JSON and non-records are null, never a throw", () => {
  for (const bad of ["", "{", "not json", "null", "[]", '"str"', "{}", '{"feature":"f"}']) assert.equal(parseRecord(bad), null, bad);
  assert.equal(parseRecord(JSON.stringify(EXAMPLE)).feature, "chat-stop-button");
});

// ── cwd → candidate roots ──

test("candidateRoots: cwd then ancestors, nearest first; stops below home and the fs root", () => {
  assert.deepEqual(candidateRoots("/home/dev/ws/repos/backend", { home: "/home/dev" }),
    ["/home/dev/ws/repos/backend", "/home/dev/ws/repos", "/home/dev/ws"]);
  assert.deepEqual(candidateRoots("/home/dev", { home: "/home/dev" }), [], "home itself is never a workspace");
  assert.deepEqual(candidateRoots("/srv/ws/", { home: "/home/dev" }), ["/srv/ws", "/srv"], "outside home: up to, not including, /");
  assert.deepEqual(candidateRoots("/", { home: "/home/dev" }), []);
});

test("candidateRoots: depth-limited; relative or missing cwd yields nothing", () => {
  const deep = "/a/b/c/d/e/f/g/h/i/j/k/l";
  const got = candidateRoots(deep, { home: "/home/dev" });
  assert.equal(got.length, MAX_WALK_DEPTH);
  assert.equal(got[0], deep);
  assert.deepEqual(candidateRoots(deep, { home: "/home/dev", maxDepth: 2 }), [deep, "/a/b/c/d/e/f/g/h/i/j/k"]);
  for (const bad of [undefined, null, "", "relative/path", 42, {}]) assert.deepEqual(candidateRoots(bad, { home: "/home/dev" }), []);
});

test("activeRecords: only records naming the checked-out branch", () => {
  const recs = [{ slug: "a", branch: "one" }, { slug: "b", branch: "two" }, { slug: "c", branch: "one" }, null];
  assert.deepEqual(activeRecords(recs, "one").map((r) => r.slug), ["a", "c"]);
  assert.deepEqual(activeRecords(recs, "three"), []);
  assert.deepEqual(activeRecords(recs, undefined), []);
});

// ── disk: workspace discovery ──

test("findWorkspace: session at the root → the active record; other-branch records ignored", async () => {
  _clearCache();
  const base = await tmp("root");
  const root = path.join(base, "adhesive-tarsier"); // dir name is NOT the branch
  await makeRoot(root, "chat-stop-button", {
    "chat-stop-button": EXAMPLE,
    "old-thing": { feature: "old-thing", branch: "old-thing", title: "inherited history" },
  });
  const ws = await findWorkspace(root, { home: base });
  assert.equal(ws.root, root);
  assert.equal(ws.branch, "chat-stop-button");
  assert.deepEqual(ws.features.map((f) => f.slug), ["chat-stop-button"]);
  assert.equal(ws.features[0].title, "Stop button for chat");
  await fsp.rm(base, { recursive: true, force: true });
});

test("findWorkspace: nested dirs walk up — past a nested checkout on another branch", async () => {
  _clearCache();
  const base = await tmp("nested");
  const root = path.join(base, "ws");
  await makeRoot(root, "feat/x", { x: { feature: "x", branch: "feat/x" } });
  // <root>/repos/backend is its own checkout on a different branch, with its own features/
  // dir whose only record names yet another branch → not active there, keep walking up.
  const backend = path.join(root, "repos", "backend");
  await makeRoot(backend, "backend-branch", { stale: { feature: "stale", branch: "long-gone" } });
  const deep = path.join(backend, "src", "api");
  await fsp.mkdir(deep, { recursive: true });
  for (const cwd of [root, path.join(root, "repos"), backend, deep]) {
    const ws = await findWorkspace(cwd, { home: base });
    assert.equal(ws && ws.root, root, cwd);
  }
  // a path that only LOOKS nested (shared prefix) is not inside the workspace
  assert.equal(await findWorkspace(path.join(base, "ws-other"), { home: base }), null);
  await fsp.rm(base, { recursive: true, force: true });
});

test("findWorkspace: the nearest ancestor with an ACTIVE record wins", async () => {
  _clearCache();
  const base = await tmp("nearest");
  const root = path.join(base, "ws");
  await makeRoot(root, "outer", { outer: { feature: "outer", branch: "outer" } });
  const inner = path.join(root, "repos", "inner");
  await makeRoot(inner, "inner-branch", { inner: { feature: "inner", branch: "inner-branch" } });
  assert.equal((await findWorkspace(path.join(inner, "src"), { home: base })).root, inner);
  assert.equal((await findWorkspace(path.join(root, "repos"), { home: base })).root, root);
  await fsp.rm(base, { recursive: true, force: true });
});

test("findWorkspace: worktree-style `.git` FILE root resolves its branch from the gitdir", async () => {
  _clearCache();
  const base = await tmp("wt");
  const gitdir = path.join(base, "main", ".git", "worktrees", "tarsier");
  await fsp.mkdir(gitdir, { recursive: true });
  await fsp.writeFile(path.join(gitdir, "HEAD"), "ref: refs/heads/control-plane\n");
  const root = path.join(base, "worktrees", "tarsier");
  await fsp.mkdir(path.join(root, "features", "cp"), { recursive: true });
  await fsp.writeFile(path.join(root, ".git"), `gitdir: ${gitdir}\n`);
  await fsp.writeFile(path.join(root, "features", "cp", "status.json"), JSON.stringify({ feature: "cp", branch: "control-plane" }));
  await fsp.mkdir(path.join(root, "features", "tarsier"), { recursive: true }); // record named like the DIR → must not match
  await fsp.writeFile(path.join(root, "features", "tarsier", "status.json"), JSON.stringify({ feature: "tarsier", branch: "tarsier" }));
  const ws = await findWorkspace(path.join(root, "features"), { home: base });
  assert.equal(ws.branch, "control-plane");
  assert.deepEqual(ws.features.map((f) => f.feature), ["cp"]);
  await fsp.rm(base, { recursive: true, force: true });
});

test("findWorkspace: no workspace → null (no features/, not a checkout root, no active record, detached)", async () => {
  _clearCache();
  const base = await tmp("none");
  // plain dir
  const plain = path.join(base, "plain");
  await fsp.mkdir(plain, { recursive: true });
  assert.equal(await findWorkspace(plain, { home: base }), null);
  // a features/ dir that is not at a checkout root (think src/features)
  const src = path.join(base, "repo", "src");
  await fsp.mkdir(path.join(src, "features", "login"), { recursive: true });
  await fsp.writeFile(path.join(src, "features", "login", "status.json"), JSON.stringify({ feature: "login", branch: "main" }));
  assert.equal(await findWorkspace(src, { home: base }), null);
  // checkout root whose records all name other branches
  const other = path.join(base, "other");
  await makeRoot(other, "main", { a: { feature: "a", branch: "not-main" } });
  assert.equal(await findWorkspace(other, { home: base }), null);
  // detached HEAD
  const detached = path.join(base, "detached");
  await makeRoot(detached, "x", { a: { feature: "a", branch: "0123456" } });
  await fsp.writeFile(path.join(detached, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  assert.equal(await findWorkspace(detached, { home: base }), null);
  // beyond the walk bound: the home directory itself is never examined
  const home = path.join(base, "home");
  await makeRoot(home, "main", { a: { feature: "a", branch: "main" } });
  assert.equal(await findWorkspace(path.join(home, "proj"), { home }), null);
  await fsp.rm(base, { recursive: true, force: true });
});

test("findWorkspace: hostile record files are skipped and never throw; valid neighbours still load", async () => {
  _clearCache();
  const base = await tmp("hostile");
  const root = path.join(base, "ws");
  await makeRoot(root, "main", {
    good: { feature: "good", branch: "main", title: "<img src=x onerror=alert(1)>" },
    "bad-json": "{ this is not json",
    empty: "",
    array: "[1,2,3]",
    "wrong-types": { feature: { a: 1 }, branch: 5 },
    huge: JSON.stringify({ feature: "huge", branch: "main", now: "x".repeat(MAX_RECORD_BYTES) }),
  });
  await fsp.mkdir(path.join(root, "features", "status-is-a-dir", "status.json"), { recursive: true });
  await fsp.mkdir(path.join(root, "features", "no-status"), { recursive: true });
  await fsp.writeFile(path.join(root, "features", "stray-file"), "not a dir");
  const ws = await findWorkspace(root, { home: base });
  assert.deepEqual(ws.features.map((f) => f.slug), ["good"]);
  assert.equal(ws.features[0].title, "<img src=x onerror=alert(1)>", "kept as inert text — the dashboard escapes it");
  await fsp.rm(base, { recursive: true, force: true });
});

test("loadWorkspace: cached for the TTL, then re-read (a branch switch or edit is picked up)", async () => {
  _clearCache();
  const base = await tmp("ttl");
  const root = path.join(base, "ws");
  await makeRoot(root, "one", { one: { feature: "one", branch: "one", stage: "building" }, two: { feature: "two", branch: "two" } });
  const t0 = 1_000_000;
  assert.equal((await loadWorkspace(root, t0)).features[0].feature, "one");
  // switch branch + edit on disk
  await fsp.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/two\n");
  assert.equal((await loadWorkspace(root, t0 + WORKSPACE_TTL_MS - 1)).features[0].feature, "one", "inside the TTL: no re-read");
  assert.equal(loadWorkspace(root, t0 + 1), loadWorkspace(root, t0 + 2), "concurrent callers share one read");
  assert.equal((await loadWorkspace(root, t0 + WORKSPACE_TTL_MS)).features[0].feature, "two", "TTL elapsed: re-read");
  // the record disappears → the workspace does too
  await fsp.rm(path.join(root, "features"), { recursive: true, force: true });
  assert.equal(await loadWorkspace(root, t0 + 3 * WORKSPACE_TTL_MS), null);
  await fsp.rm(base, { recursive: true, force: true });
});

// ── steering target ──

test("pickSteerTarget: newest non-ended session AT the root, else newest non-ended, else newest", () => {
  const S = (sessionId, cwd, status, lastTs) => ({ sessionId, cwd, status, lastTs });
  const root = "/w/ws";
  assert.equal(pickSteerTarget(root, [
    S("nested-newest", "/w/ws/repos/backend", "working", 900),
    S("root-old", "/w/ws", "idle", 100),
    S("root-new", "/w/ws/", "stale", 500), // trailing slash + stale still count as "at root, not ended"
    S("root-ended", "/w/ws", "ended", 999),
  ]), "root-new");
  assert.equal(pickSteerTarget(root, [
    S("nested-a", "/w/ws/repos/backend", "idle", 300),
    S("nested-b", "/w/ws/repos/web", "working", 700),
    S("root-ended", "/w/ws", "ended", 999),
  ]), "nested-b", "no live session at the root → newest live one anywhere");
  assert.equal(pickSteerTarget(root, [S("e1", "/w/ws", "ended", 10), S("e2", "/w/ws/x", "ended", 20)]), "e2", "all ended → newest");
  assert.equal(pickSteerTarget(root, []), null);
});

// ── sorting + assembly ──

test("sortFeatures: waiting first, then session attention, then most recently updated", () => {
  const F = (slug, o = {}) => ({ root: "/w/" + slug, slug, waiting: null, sessions: [], ...o });
  const sorted = sortFeatures([
    F("calm-old", { updated: "2026-10-01T00:00:00.000Z" }),
    F("calm-new", { updated: "2026-10-10T00:00:00.000Z" }),
    F("attn", { updated: "2026-09-01T00:00:00.000Z", sessions: [{ attention: false, lastTs: 1 }, { attention: true, lastTs: 2 }] }),
    F("waiting-old", { updated: "2026-08-01T00:00:00.000Z", waiting: { question: "?", options: [] } }),
    F("waiting-new", { updated: "2026-08-02T00:00:00.000Z", waiting: { question: "?", options: [] } }),
    F("no-updated", { sessions: [{ attention: false, lastTs: Date.parse("2026-10-05T00:00:00.000Z") }] }),
  ]).map((f) => f.slug);
  assert.deepEqual(sorted, ["waiting-new", "waiting-old", "attn", "calm-new", "no-updated", "calm-old"]);
});

test("sortFeatures: does not mutate its input and is deterministic on ties", () => {
  const input = [{ root: "/w/b", slug: "b", waiting: null, sessions: [] }, { root: "/w/a", slug: "a", waiting: null, sessions: [] }];
  const out = sortFeatures(input);
  assert.deepEqual(input.map((f) => f.slug), ["b", "a"]);
  assert.deepEqual(out.map((f) => f.slug), ["a", "b"]);
});

test("buildFeatures: groups sessions under their workspace's feature with rows, target and attention", () => {
  const ws = { root: "/w/ws", branch: "x", features: [{ slug: "x", feature: "x", branch: "x", waiting: null, verified: [], prs: [], actions: [] }] };
  const quiet = { root: "/w/quiet", branch: "q", features: [{ slug: "q", feature: "q", branch: "q", waiting: null, verified: [], prs: [], actions: [], updated: "2030-01-01T00:00:00.000Z" }] };
  const row = (sessionId, o = {}) => ({ sessionId, status: "idle", lastTs: 1, attention: false, ...o });
  const out = buildFeatures([
    { workspace: ws, cwd: "/w/ws/repos/backend", row: row("nested", { lastTs: 50, status: "working" }) },
    { workspace: null, cwd: "/elsewhere", row: row("loner") },
    { workspace: ws, cwd: "/w/ws", row: row("at-root", { lastTs: 10 }) },
    { workspace: ws, cwd: "/w/ws/repos/web", row: row("needy", { lastTs: 5, attention: true, status: "waiting" }) },
    { workspace: quiet, cwd: "/w/quiet", row: row("q1") },
  ]);
  assert.deepEqual(out.map((f) => f.feature), ["x", "q"], "attention outranks a newer `updated`");
  const x = out[0];
  assert.equal(x.root, "/w/ws");
  assert.equal(x.attention, true);
  assert.equal(x.targetSessionId, "at-root");
  assert.deepEqual(x.sessions.map((r) => r.sessionId), ["needy", "nested", "at-root"], "attention-first, then most recent");
  assert.equal(out[1].attention, false);
  assert.ok(!out.some((f) => f.sessions.some((r) => r.sessionId === "loner")));
  assert.deepEqual(buildFeatures([]), []);
});
