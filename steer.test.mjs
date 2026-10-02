// steer.test.mjs — unit tests for the pure steering brain (no server, no I/O).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectDirective, renderResponse, initialStatus, kindForHook, isExpired,
  normalizeKind, normalizeMode, STATUS, DEFAULT_AUTO_KINDS,
  isTmuxDeliverable, renderTmuxText, promptIsEmpty, decideKeys, decisionPromptReady, STEER_KINDS,
  GRANT_STATUS, DEFAULT_GRANT_TTL_MS, isGrantActive, isGrantPending,
} from "./steer.mjs";

const NOW = 1_000_000;

// A small directive factory so each test states only what differs.
function dir(over = {}) {
  return {
    id: over.id || "d1",
    sessionId: "s1",
    kind: "nudge",
    text: "do the thing",
    toolMatch: undefined,
    status: STATUS.ARMED,
    createdTs: NOW - 1000,
    expiresTs: NOW + 60_000,
    ...over,
  };
}

const onCtx = (over = {}) => ({ masterOn: true, mode: "autonomous", now: NOW, ...over });

// ── selectDirective gating ────────────────────────────────────────────────

test("master switch off → null", () => {
  assert.equal(selectDirective({ hook_event_name: "Stop", session_id: "s1" }, [dir()], onCtx({ masterOn: false })), null);
});

test("mode off → null", () => {
  assert.equal(selectDirective({ hook_event_name: "Stop", session_id: "s1" }, [dir()], onCtx({ mode: "off" })), null);
});

test("non-steerable hook (PostToolUse) → null", () => {
  assert.equal(selectDirective({ hook_event_name: "PostToolUse", session_id: "s1" }, [dir()], onCtx()), null);
});

test("hook kind mismatch (Stop hook, context directive) → null", () => {
  assert.equal(selectDirective({ hook_event_name: "Stop", session_id: "s1" }, [dir({ kind: "context" })], onCtx()), null);
});

test("proposed directive is not deliverable → null", () => {
  assert.equal(selectDirective({ hook_event_name: "Stop", session_id: "s1" }, [dir({ status: STATUS.PROPOSED })], onCtx()), null);
});

test("nudge skipped when stop_hook_active (stop-loop guard) → null", () => {
  assert.equal(selectDirective({ hook_event_name: "Stop", session_id: "s1", stop_hook_active: true }, [dir()], onCtx()), null);
});

test("expired armed directive → null", () => {
  assert.equal(selectDirective({ hook_event_name: "Stop", session_id: "s1" }, [dir({ expiresTs: NOW - 1 })], onCtx()), null);
});

test("block_tool only matches when tool_match equals tool_name", () => {
  const d = dir({ kind: "block_tool", toolMatch: "Bash" });
  assert.equal(selectDirective({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Edit" }, [d], onCtx()), null);
  assert.equal(selectDirective({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash" }, [d], onCtx())?.id, "d1");
});

test("block_tool with empty tool_match matches any tool", () => {
  const d = dir({ kind: "block_tool", toolMatch: undefined });
  assert.equal(selectDirective({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Anything" }, [d], onCtx())?.id, "d1");
});

test("happy path: armed nudge on Stop in autonomous → selected", () => {
  const got = selectDirective({ hook_event_name: "Stop", session_id: "s1" }, [dir()], onCtx());
  assert.equal(got.id, "d1");
});

test("approval mode still delivers an armed directive (post-approval)", () => {
  const got = selectDirective({ hook_event_name: "Stop", session_id: "s1" }, [dir()], onCtx({ mode: "approval" }));
  assert.equal(got.id, "d1");
});

test("FIFO: oldest armed directive wins", () => {
  const a = dir({ id: "old", createdTs: NOW - 5000 });
  const b = dir({ id: "new", createdTs: NOW - 100 });
  assert.equal(selectDirective({ hook_event_name: "Stop", session_id: "s1" }, [b, a], onCtx()).id, "old");
});

test("delivered directive is never re-selected", () => {
  assert.equal(selectDirective({ hook_event_name: "Stop", session_id: "s1" }, [dir({ status: STATUS.DELIVERED })], onCtx()), null);
});

// ── renderResponse exact field paths ──────────────────────────────────────

test("renderResponse nudge → decision:block + reason + banner", () => {
  const r = renderResponse(dir({ kind: "nudge", text: "add tests" }));
  assert.equal(r.decision, "block");
  assert.equal(r.reason, "[observer] add tests");
  assert.match(r.systemMessage, /observer steered this session: add tests/);
});

test("renderResponse context → hookSpecificOutput.additionalContext", () => {
  const r = renderResponse(dir({ kind: "context", text: "prefer fp" }));
  assert.equal(r.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(r.hookSpecificOutput.additionalContext, "[observer] prefer fp");
});

test("renderResponse block_tool → permissionDecision:deny + reason", () => {
  const r = renderResponse(dir({ kind: "block_tool", text: "no migrations" }));
  assert.equal(r.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(r.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(r.hookSpecificOutput.permissionDecisionReason, "[observer] no migrations");
});

// ── initialStatus (arming policy) ─────────────────────────────────────────

test("autonomous auto-arms context and nudge", () => {
  assert.equal(initialStatus("context", "autonomous"), STATUS.ARMED);
  assert.equal(initialStatus("nudge", "autonomous"), STATUS.ARMED);
});

test("autonomous still requires approval for block_tool", () => {
  assert.equal(initialStatus("block_tool", "autonomous"), STATUS.PROPOSED);
});

test("approval mode leaves everything proposed", () => {
  for (const k of ["context", "nudge", "block_tool"]) {
    assert.equal(initialStatus(k, "approval"), STATUS.PROPOSED);
  }
});

test("custom autoKinds can withhold nudge", () => {
  assert.equal(initialStatus("nudge", "autonomous", ["context"]), STATUS.PROPOSED);
  assert.equal(initialStatus("context", "autonomous", ["context"]), STATUS.ARMED);
});

// ── helpers ───────────────────────────────────────────────────────────────

test("kindForHook maps the three steerable hooks, null otherwise", () => {
  assert.equal(kindForHook("UserPromptSubmit"), "context");
  assert.equal(kindForHook("Stop"), "nudge");
  assert.equal(kindForHook("PreToolUse"), "block_tool");
  assert.equal(kindForHook("PostToolUse"), null);
});

test("isExpired honors expiresTs; 0/undefined never expires", () => {
  assert.equal(isExpired({ expiresTs: NOW - 1 }, NOW), true);
  assert.equal(isExpired({ expiresTs: NOW + 1 }, NOW), false);
  assert.equal(isExpired({ expiresTs: 0 }, NOW), false);
  assert.equal(isExpired({}, NOW), false);
});

test("normalizeKind / normalizeMode reject junk", () => {
  assert.equal(normalizeKind("nudge"), "nudge");
  assert.equal(normalizeKind("delete_repo"), null);
  assert.equal(normalizeMode("autonomous"), "autonomous");
  assert.equal(normalizeMode("yolo"), null);
});

test("DEFAULT_AUTO_KINDS excludes block_tool", () => {
  assert.ok(!DEFAULT_AUTO_KINDS.includes("block_tool"));
});

// ── idle delivery helpers (tmux send-keys path) ──────────────────────────────

test("isTmuxDeliverable: context & nudge collapse to 'type a prompt'; block_tool doesn't", () => {
  assert.equal(isTmuxDeliverable("context"), true);
  assert.equal(isTmuxDeliverable("nudge"), true);
  assert.equal(isTmuxDeliverable("block_tool"), false); // no pending tool at an idle prompt
  assert.equal(isTmuxDeliverable("bogus"), false);
});

test("renderTmuxText: prefixes [observer] so the typed prompt is attributable", () => {
  assert.equal(renderTmuxText({ text: "also add tests" }), "[observer] also add tests");
  assert.equal(renderTmuxText({}), "[observer] ");
  assert.equal(renderTmuxText(null), "[observer] ");
});

test("promptIsEmpty: only an empty prompt line is safe to type into", () => {
  assert.equal(promptIsEmpty("some output\n❯ "), true);
  assert.equal(promptIsEmpty("❯ "), true);
  assert.equal(promptIsEmpty("❯ \n\n  "), true);        // trailing blanks ignored
  assert.equal(promptIsEmpty("> "), true);              // ascii fallback glyph
  assert.equal(promptIsEmpty("❯ half typed"), false);   // don't clobber pending text
  assert.equal(promptIsEmpty("> wip"), false);
  assert.equal(promptIsEmpty("no prompt here"), false); // unknown render → unsafe
  assert.equal(promptIsEmpty(""), false);
});

// ── control grants (explicit consent) ───────────────────────────────────────

test("isGrantActive: only a granted, in-TTL grant holds control", () => {
  const N = 1000;
  assert.equal(isGrantActive({ status: GRANT_STATUS.GRANTED, expiresTs: N + 100 }, N), true);
  assert.equal(isGrantActive({ status: GRANT_STATUS.GRANTED, expiresTs: N - 1 }, N), false); // TTL lapsed
  assert.equal(isGrantActive({ status: GRANT_STATUS.GRANTED }, N), true);                    // no TTL → active
  assert.equal(isGrantActive({ status: GRANT_STATUS.REQUESTED, expiresTs: N + 100 }, N), false);
  assert.equal(isGrantActive({ status: GRANT_STATUS.REVOKED }, N), false);
  assert.equal(isGrantActive(null, N), false);
});

test("isGrantPending: only a requested grant is awaiting consent", () => {
  assert.equal(isGrantPending({ status: GRANT_STATUS.REQUESTED }), true);
  assert.equal(isGrantPending({ status: GRANT_STATUS.GRANTED }), false);
  assert.equal(isGrantPending(null), false);
});

test("DEFAULT_GRANT_TTL_MS is 30 minutes", () => {
  assert.equal(DEFAULT_GRANT_TTL_MS, 30 * 60 * 1000);
});

// ── decide kind (answering interactive decision prompts) ────────────────────

test("decide is a steerable, auto-arming, pane-deliverable kind", () => {
  assert.ok(STEER_KINDS.includes("decide"));
  assert.ok(DEFAULT_AUTO_KINDS.includes("decide"));   // covered by autonomous/grant
  assert.equal(isTmuxDeliverable("decide"), true);
  assert.equal(kindForHook("decide"), null);          // never a hook lever
});

test("decideKeys: plan accept-aliases → option 1; else pass-through", () => {
  for (const a of ["accept", "approve", "yes", "proceed", "1"]) assert.equal(decideKeys(a, "plan"), "1");
  assert.equal(decideKeys("3", "plan"), "3");          // explicit option number
});

test("decideKeys: question index / label / free text", () => {
  assert.equal(decideKeys("2", "question", ["A", "B", "C"]), "2");        // explicit index
  assert.equal(decideKeys("SQLite", "question", ["Postgres", "SQLite"]), "2"); // label → index
  assert.equal(decideKeys("something else", "question", ["A", "B"]), "something else"); // free text
});

test("decisionPromptReady: matches a painted menu, rejects a plain prompt", () => {
  assert.equal(decisionPromptReady("Plan:\n❯ 1. Yes, proceed\n  2. No, keep planning"), true);
  assert.equal(decisionPromptReady("Would you like to proceed?"), true);
  assert.equal(decisionPromptReady("❯ "), false);      // an empty free-text prompt is not a decision
  assert.equal(decisionPromptReady(""), false);
});
