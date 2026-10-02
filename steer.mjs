// steer.mjs — bounded write-back into live Claude Code sessions (zero deps, pure).
//
// The observer already sits in the SYNCHRONOUS path of every Claude Code hook
// (POST /events). Claude Code honors a hook's HTTP response body as hook output, so
// the collector can hand a session a steering directive at a hook checkpoint by
// returning the right JSON. This module is the pure brain of that: given a hook
// payload and the active directive queue, pick the one deliverable directive (gating
// + match + FIFO + TTL) and render the exact hook-output JSON. No I/O, no mutation of
// inputs beyond the explicit status transition the collector asks for — so it tests
// fully offline.
//
//   hook payload ─┐
//                 ├─► selectDirective(payload, directives, ctx) ─► directive | null
//   directives ───┘                                                    │
//                                                                       ▼
//                                                          renderResponse(directive)
//                                                                       │
//                                                            hook-output JSON (or {ok:true})
//
// FOUR KINDS. Three hook vectors (soft → hard), each a different hook + response shape:
//   context     UserPromptSubmit  → inject additionalContext into the next prompt
//   nudge       Stop              → decision:block + reason → redirect at turn end
//   block_tool  PreToolUse        → permissionDecision:deny → stop a tool call
// plus `decide`, which answers a pending plan-approval / question prompt and is delivered
// only by typing into the session's live tmux pane (decideKeys below).
//
// GUARDRAILS live in selectDirective(): master switch, per-session mode, arming,
// one-shot consume, TTL, stop-loop protection, tool matching. Default-deny throughout.

export const STEER_KINDS = ["context", "nudge", "block_tool", "decide"];

// Directive lifecycle: proposed → armed → delivered | expired | cancelled.
export const STATUS = {
  PROPOSED: "proposed",   // created in approval mode (or block_tool in autonomous): not deliverable
  ARMED: "armed",         // approved / auto-armed: deliverable at the next matching checkpoint
  DELIVERED: "delivered", // consumed once (terminal)
  EXPIRED: "expired",     // TTL elapsed before delivery (terminal)
  CANCELLED: "cancelled", // retracted (terminal)
};

export const SESSION_MODES = ["off", "approval", "autonomous"];

export const DEFAULT_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_AUTO_KINDS = ["context", "nudge", "decide"]; // block_tool always needs approval

// Which hook event delivers which kind. The collector reads payload.hook_event_name.
const KIND_BY_HOOK = {
  UserPromptSubmit: "context",
  Stop: "nudge",
  PreToolUse: "block_tool",
};
export function kindForHook(hookEventName) {
  return KIND_BY_HOOK[hookEventName] || null;
}

// Is a directive past its TTL at `now`? Undefined/0 expiresTs => never expires.
export function isExpired(d, now) {
  return !!d.expiresTs && now >= d.expiresTs;
}

// selectDirective — the single decision point. Pure: never mutates inputs. Returns the
// one directive that should be delivered for this hook, or null. The collector is
// responsible for the side effects (mark delivered, audit, persist) once we return one.
//
//   payload     : raw hook payload { hook_event_name, session_id, tool_name?, stop_hook_active? }
//   directives  : iterable of directive objects for THIS session (any status)
//   ctx         : { masterOn, mode, now }
//
// Delivery requires ALL of:
//   - master switch on
//   - session mode is "approval" or "autonomous" (never "off")
//   - the hook maps to a kind (only the three steerable hooks)
//   - an ARMED, non-expired directive of that kind exists (FIFO by createdTs)
//   - nudge: payload.stop_hook_active is falsy (don't pile onto an existing block loop)
//   - block_tool: directive.toolMatch is empty OR equals payload.tool_name
export function selectDirective(payload, directives, ctx) {
  const { masterOn, mode, now } = ctx;
  if (!masterOn) return null;
  if (mode !== "approval" && mode !== "autonomous") return null;
  const kind = kindForHook(payload && payload.hook_event_name);
  if (!kind) return null;
  if (kind === "nudge" && payload.stop_hook_active) return null; // stop-loop guard

  const toolName = payload.tool_name;
  const candidates = [];
  for (const d of directives) {
    if (d.status !== STATUS.ARMED) continue;
    if (d.kind !== kind) continue;
    if (isExpired(d, now)) continue; // expiry is finalized by the collector's sweep
    if (kind === "block_tool" && d.toolMatch && d.toolMatch !== toolName) continue;
    candidates.push(d);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.createdTs || 0) - (b.createdTs || 0)); // FIFO
  return candidates[0];
}

// renderResponse — pure map from a directive to the exact hook-output JSON Claude Code
// expects for that hook event. The systemMessage makes the steer VISIBLE to the human
// at the keyboard (transparency guardrail) on every kind.
export function renderResponse(d) {
  const text = d.text || "";
  const banner = `⚠ observer steered this session: ${text}`;
  switch (d.kind) {
    case "nudge":
      return { decision: "block", reason: `[observer] ${text}`, systemMessage: banner };
    case "context":
      return {
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `[observer] ${text}` },
        systemMessage: banner,
      };
    case "block_tool":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `[observer] ${text}`,
        },
        systemMessage: banner,
      };
    default:
      return null;
  }
}

// ── Control grants (explicit, scoped, operator-consented autonomy) ──
// A grant is the "take control of a task" handshake: the agent REQUESTS (it can never grant
// itself — no MCP grant tool exists), the operator GRANTS, and while active the session is
// treated as autonomous for steering — bounded by a TTL, ended early when the agent marks the
// task done (release), and revocable instantly. The grant IS the consent; it overrides an
// otherwise-`off` session. block_tool still never auto-arms, even under a grant.
export const GRANT_STATUS = {
  REQUESTED: "requested", // The agent asked; awaiting operator approval (not yet active)
  GRANTED: "granted",     // operator approved; active until TTL / release / revoke
  DENIED: "denied",       // operator declined (terminal)
  RELEASED: "released",   // The agent gave it back, task done (terminal)
  REVOKED: "revoked",     // operator pulled it (terminal)
  EXPIRED: "expired",     // TTL elapsed (terminal)
};
export const DEFAULT_GRANT_TTL_MS = 30 * 60 * 1000;

// Control is currently held only while granted and within TTL (TTL+task-done scope: the
// collector ends it early on release, the sweep ends it on TTL).
export function isGrantActive(g, now) {
  return !!g && g.status === GRANT_STATUS.GRANTED && (!g.expiresTs || now < g.expiresTs);
}
// Pending = requested by the agent, waiting for the operator's explicit yes.
export function isGrantPending(g) {
  return !!g && g.status === GRANT_STATUS.REQUESTED;
}

// ── Idle delivery (tmux send-keys) ──
// Hooks only fire while a turn is active, so an idle session (parked at the prompt) is
// unreachable through the hook response. The collector closes that gap by typing the
// directive into the session's terminal via `tmux send-keys`. These helpers are the pure
// part of that path; the collector owns the actual exec + gating.

// Kinds typed into a live pane: context/nudge at an idle prompt, and `decide` to answer an
// interactive decision prompt. block_tool is N/A (a real-time deny has no pane form).
export const TMUX_KINDS = ["context", "nudge", "decide"];
export function isTmuxDeliverable(kind) {
  return TMUX_KINDS.includes(kind);
}

// `decide` maps an intent to the keystrokes to type at a decision prompt (the caller adds
// Enter). Pure. For a plan approval, accept-aliases pick the proceed option ("1"); other
// values pass through (the steerer can send an explicit option number). For a question, a
// numeric index passes through, a label is matched to its 1-based index, else it's free text
// (an "Other" answer).
export function decideKeys(choice, decisionType, options = []) {
  const c = String(choice == null ? "" : choice).trim();
  const lc = c.toLowerCase();
  if (decisionType === "plan") {
    if (["accept", "approve", "yes", "y", "proceed", "ok", "1"].includes(lc)) return "1";
    return c; // explicit option number / other layout — steerer's responsibility
  }
  if (/^\d+$/.test(c)) return c;                 // explicit option index
  const idx = options.findIndex((o) => String(o).trim().toLowerCase() === lc);
  if (idx >= 0) return String(idx + 1);          // matched a known option label
  return c;                                       // free text (e.g. an "Other" field)
}

// Has the decision UI painted? PreToolUse fires BEFORE the prompt renders, so the collector
// confirms readiness before typing. Matches a numbered menu / plan-approval signatures.
export function decisionPromptReady(paneText) {
  const t = String(paneText == null ? "" : paneText);
  return /(^|\n)\s*[❯>]?\s*\d+[.)]\s/.test(t)     // a numbered menu line ("1. Yes…" / "1) …")
      || /would you like to proceed/i.test(t)
      || /keep planning/i.test(t)
      || /esc to (cancel|reject|interrupt)/i.test(t);
}

// The literal text we type into an idle prompt. Prefixed so the developer scrolling their
// own transcript sees it came from the agent — same transparency intent as the systemMessage
// banner on the hook path (which an idle send-keys can't carry).
export function renderTmuxText(d) {
  return `[observer] ${d && d.text ? d.text : ""}`;
}

// Given a terminal capture, is the agent's prompt line empty (safe to type into)? We find
// the last line beginning with Claude Code's prompt glyph and check it has no pending text,
// so a send-keys never clobbers something the developer half-typed. No prompt found → unsafe.
export function promptIsEmpty(paneText) {
  const lines = String(paneText == null ? "" : paneText).replace(/[ \t\r\n]+$/g, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*[❯>]\s?(.*)$/);
    if (m) return m[1].trim() === "";
  }
  return false;
}

// initialStatus — given a creation request and the session's mode + auto-arm policy,
// decide whether the directive starts armed or needs approval. block_tool never
// auto-arms (the only lever that denies an action), regardless of autoKinds.
export function initialStatus(kind, mode, autoKinds = DEFAULT_AUTO_KINDS) {
  if (mode === "autonomous" && kind !== "block_tool" && autoKinds.includes(kind)) {
    return STATUS.ARMED;
  }
  return STATUS.PROPOSED;
}

// normalizeKind / normalizeMode — input hardening for the API + MCP write surface.
export function normalizeKind(k) {
  return STEER_KINDS.includes(k) ? k : null;
}
export function normalizeMode(m) {
  return SESSION_MODES.includes(m) ? m : null;
}
