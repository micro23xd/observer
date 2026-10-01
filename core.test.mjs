// core.test.mjs — unit tests for the pure label derivation (no server, no I/O).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorktreePath, deriveRepo, reduce, newSession } from "./core.mjs";

// ── parseWorktreePath ──────────────────────────────────────────────────────

test("parseWorktreePath: Superset path → repo + full branch (slashes kept)", () => {
  assert.deepEqual(
    parseWorktreePath("/home/dev/.superset/worktrees/web-app/feat/search-v2"),
    { repo: "web-app", branch: "feat/search-v2" });
});

test("parseWorktreePath: worktree root with no branch subdir → branch undefined", () => {
  assert.deepEqual(parseWorktreePath("/x/worktrees/web-ui"), { repo: "web-ui", branch: undefined });
});

test("parseWorktreePath: single-segment branch", () => {
  assert.deepEqual(parseWorktreePath("/x/worktrees/repo/main"), { repo: "repo", branch: "main" });
});

test("parseWorktreePath: trailing slash tolerated", () => {
  assert.deepEqual(parseWorktreePath("/x/worktrees/repo/feat/y/"), { repo: "repo", branch: "feat/y" });
});

test("parseWorktreePath: non-worktree path → null", () => {
  assert.equal(parseWorktreePath("/home/dev/src/acme/web-app"), null);
  assert.equal(parseWorktreePath("/tmp/vertex-demo"), null);
  assert.equal(parseWorktreePath(""), null);
  assert.equal(parseWorktreePath(undefined), null);
});

// ── deriveRepo precedence ──────────────────────────────────────────────────

test("deriveRepo: worktree path with NO gitBranch → repo@branch (the live-session fix)", () => {
  assert.equal(deriveRepo("/x/.superset/worktrees/web-app/fix/login-redirect"),
    "web-app@fix/login-redirect");
});

test("deriveRepo: explicit repoName + gitBranch win over the path", () => {
  assert.equal(deriveRepo("/x/dev/acme/web-app", "main", "web-app"), "web-app@main");
});

test("deriveRepo: explicit repoName beats worktree-path repo", () => {
  assert.equal(deriveRepo("/x/worktrees/wrong/feat/z", undefined, "right"), "right@feat/z");
});

test("deriveRepo: plain path falls back to last segment", () => {
  assert.equal(deriveRepo("/home/dev/dev/AI/claude-collector"), "claude-collector");
  assert.equal(deriveRepo("/home/dev/dev/AI/claude-collector", "steer-sessions"), "claude-collector@steer-sessions");
});

test("deriveRepo: no cwd, no repoName → undefined", () => {
  assert.equal(deriveRepo(undefined, "main"), undefined);
});

// ── reduce threads repoName + recomputes label ─────────────────────────────

test("reduce: a live worktree event (cwd only) yields repo@branch", () => {
  const s = newSession("w1");
  reduce(s, { sessionId: "w1", ts: 1, kind: "prompt", prompt: "hi",
    cwd: "/x/.superset/worktrees/web-ui/feat/dark-mode" });
  assert.equal(s.repo, "web-ui@feat/dark-mode");
});

test("reduce: repoName from event (plain checkout) is used and sticks", () => {
  const s = newSession("p1");
  reduce(s, { sessionId: "p1", ts: 1, kind: "prompt", prompt: "hi",
    cwd: "/x/dev/acme/web-app", gitBranch: "main", repoName: "web-app" });
  assert.equal(s.repoName, "web-app");
  assert.equal(s.repo, "web-app@main");
});

// ── decision-prompt detection (ExitPlanMode / AskUserQuestion) ──────────────

test("reduce: ExitPlanMode tool → awaitingDecision 'plan' + status waiting", () => {
  const s = newSession("d1");
  reduce(s, { sessionId: "d1", ts: 1, kind: "prompt", prompt: "do it" });
  reduce(s, { sessionId: "d1", ts: 2, kind: "tool", tool: "ExitPlanMode", input: { plan: "the plan" } });
  assert.equal(s.awaitingDecision, "plan");
  assert.equal(s.status, "waiting");
  assert.match(s.now, /plan approval/);
});

test("reduce: AskUserQuestion captures option labels for routing a decide", () => {
  const s = newSession("d2");
  reduce(s, { sessionId: "d2", ts: 1, kind: "tool", tool: "AskUserQuestion",
    input: { questions: [{ options: [{ label: "Postgres" }, { label: "SQLite" }] }] } });
  assert.equal(s.awaitingDecision, "question");
  assert.equal(s.status, "waiting");
  assert.deepEqual(s.decisionOptions, ["Postgres", "SQLite"]);
});

test("reduce: a later event clears the awaiting-decision state", () => {
  const s = newSession("d3");
  reduce(s, { sessionId: "d3", ts: 1, kind: "tool", tool: "ExitPlanMode", input: {} });
  assert.equal(s.awaitingDecision, "plan");
  reduce(s, { sessionId: "d3", ts: 2, kind: "tool", tool: "Bash", input: { command: "ls" } });
  assert.equal(s.awaitingDecision, false);
  assert.equal(s.decisionOptions, undefined);
  assert.equal(s.status, "working");
});

test("reduce: a replayed OLDER decision tool does not hijack live status", () => {
  const s = newSession("d4");
  reduce(s, { sessionId: "d4", ts: 10, kind: "tool", tool: "Bash", input: { command: "x" } });
  reduce(s, { sessionId: "d4", ts: 2, kind: "tool", tool: "ExitPlanMode", input: {} }); // older
  assert.equal(s.awaitingDecision, false);
  assert.equal(s.status, "working");
});
