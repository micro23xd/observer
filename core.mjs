// core.mjs — shared event normalization + reducer + view builders.
//
// The single most important structural rule of hermes-observer: live hook events
// and imported transcript lines BOTH normalize into the same internal event shape,
// then go through the SAME reduce(). Identical reduction is the point — do not fork.
//
//   hook payload ─┐
//                 ├─► normalize* ─► NormalizedEvent ─► reduce(state, event) ─► state
//   transcript ───┘                                         │
//                                                           └─► view builders (overview/digest)
//
// reduce() is pure over per-session state. Side-effect scheduling (the LLM summary
// "fold" on Stop) lives in the collector, NOT in state — so imports never trigger
// summaries and the reducer stays referentially transparent.

export const STALE_MS = 30 * 60 * 1000; // idle + older than this (view-time) => "stale"
export const BUFFER_CAP = 300; // per-session ring buffer (drill-down source)
export const COMMANDS_CAP = 50; // recent bash commands

// ---------------------------------------------------------------------------
// Normalizers — both emit { ts, sessionId, cwd?, gitBranch?, kind, ... }
// ---------------------------------------------------------------------------

// hook payload -> [normalized]. ts is stamped by the collector (hooks carry none).
export function normalizeHookEvent(h, ts) {
  if (!h || typeof h !== "object") return [];
  const base = { ts, sessionId: h.session_id, cwd: h.cwd };
  // transcript_path is the escape hatch to the full raw .jsonl (Tier-3).
  if (h.transcript_path) base.transcriptPath = h.transcript_path;
  switch (h.hook_event_name) {
    case "SessionStart":       return [{ ...base, kind: "session_start" }];
    case "UserPromptSubmit":   return [{ ...base, kind: "prompt", prompt: h.prompt }];
    case "PreToolUse":         return [{ ...base, kind: "tool", tool: h.tool_name, input: h.tool_input }];
    case "PostToolUse":        return [{ ...base, kind: "tool_result", tool: h.tool_name, response: h.tool_response }];
    case "PostToolUseFailure": return [{ ...base, kind: "tool_result", tool: h.tool_name, response: h.tool_response, isError: true }];
    case "TaskCreated":        return [{ ...base, kind: "task_created", taskId: idOf(h.task_id), taskSubject: h.task_subject }];
    case "TaskCompleted":      return [{ ...base, kind: "task_completed", taskId: idOf(h.task_id), taskSubject: h.task_subject }];
    case "Notification":       return [{ ...base, kind: "notify", prompt: h.message }];
    case "Stop":               return [{ ...base, kind: "stop" }];
    case "SessionEnd":         return [{ ...base, kind: "session_end" }];
    case "SubagentStop":       return [{ ...base, kind: "subagent_stop" }];
    default:                   return [{ ...base, kind: "other" }];
  }
}

// transcript line -> [normalized]. One line can yield several events.
export function normalizeTranscriptLine(line, fileSession) {
  if (!line || typeof line !== "object") return [];
  const ts = line.timestamp ? Date.parse(line.timestamp) : undefined;
  const base = {
    ts: Number.isFinite(ts) ? ts : 0,
    sessionId: line.sessionId || fileSession,
    cwd: line.cwd,
    gitBranch: line.gitBranch,
  };
  if (line.type === "summary" && line.summary) {
    return [{ ...base, kind: "summary", prompt: line.summary }];
  }
  const content = line.message?.content;
  const out = [];
  if (line.type === "assistant" && Array.isArray(content)) {
    for (const b of content) {
      if (!b || b.type !== "tool_use") continue;
      if (b.name === "TaskCreate") {
        out.push({ ...base, kind: "task_created", taskId: idOf(b.input?.taskId ?? b.id), taskSubject: b.input?.subject });
      } else if (b.name === "TaskUpdate" && b.input?.status === "completed") {
        out.push({ ...base, kind: "task_completed", taskId: idOf(b.input?.taskId) });
      } else if (b.name === "TaskUpdate" && b.input?.status === "in_progress") {
        // The importer maps in_progress -> currentTask.
        out.push({ ...base, kind: "task_updated", taskId: idOf(b.input?.taskId), taskStatus: "in_progress" });
      } else {
        out.push({ ...base, kind: "tool", tool: b.name, input: b.input });
      }
    }
    return out;
  }
  if (line.type === "user") {
    if (Array.isArray(content)) {
      const results = content.filter((b) => b && b.type === "tool_result");
      if (results.length) {
        return results.map((r) => ({ ...base, kind: "tool_result", isError: !!r.is_error, response: r.content }));
      }
      const text = content.filter((b) => b && b.type === "text").map((b) => b.text).join(" ").trim();
      return text ? [{ ...base, kind: "prompt", prompt: text }] : [];
    }
    if (typeof content === "string" && content.trim()) {
      return [{ ...base, kind: "prompt", prompt: content }];
    }
  }
  return out;
}

function idOf(v) {
  return v === undefined || v === null ? undefined : String(v);
}

// sanitize() is the single seam for a future redaction toggle (no redaction
// now — raw content is the product's purpose). Keep all callers routing through it.
export function sanitize(event) {
  return event;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function newSession(sessionId) {
  return {
    sessionId,
    cwd: undefined,
    gitBranch: undefined,
    repoName: undefined,
    repo: undefined,
    title: undefined,
    transcriptPath: undefined,
    status: "starting",
    startedTs: undefined,
    lastTs: 0,
    turns: 0,
    toolCalls: 0,
    edits: 0,
    bash: 0,
    errors: 0,
    subagents: 0,
    unresolvedError: false, // recency flag for attention, cleared on next prompt
    files: {},
    commands: [],
    tasks: {},
    tasksOpen: 0,
    tasksDone: 0,
    currentTask: undefined,
    lastError: undefined,
    now: undefined,
    lastPrompt: undefined,
    summary: null,
    summaryTs: undefined,
    model: undefined,
    tmux: undefined, // { server, target } once the tmux launch wrapper registers a pane (collector-only)
    awaitingDecision: false,   // "plan" | "question" | false — blocked on an interactive decision
    decisionOptions: undefined, // option labels for a pending AskUserQuestion (to route a `decide`)
    buffer: [],
  };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
// Tools that BLOCK for an interactive user decision (plan approval / a question). They arrive
// as ordinary `tool` (PreToolUse) events with no following Stop until the human responds, so
// the reducer flags an "awaiting decision" state the steering layer can deliver into.
export const DECISION_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion"]);
const STATUS_BY_KIND = {
  session_start: "starting",
  prompt: "working",
  tool: "working",
  notify: "waiting",
  stop: "idle",
  session_end: "ended",
};

// reduce(state, event) -> state. Pure: returns the mutated-in-place state for
// the caller's convenience but performs no I/O and schedules no side effects.
//
//   counters/tasks/files  ── always applied (cumulative, order-tolerant)
//   status/now/lastPrompt ── applied ONLY when the event is the newest seen
//                            (a replayed older SessionEnd must not
//                             mark a live session ended)
export function reduce(state, event) {
  if (!event || !event.sessionId) return state;
  const ts = Number.isFinite(event.ts) ? event.ts : 0;
  const isLatest = ts >= state.lastTs;

  // Label derivation — first cwd/branch/repoName seen sticks; recompute the label
  // whenever we know a cwd or a resolved repo name. repoName + the worktree-path parse
  // in deriveRepo are what fix worktree labels (and fill the live branch).
  if (event.cwd && !state.cwd) state.cwd = event.cwd;
  if (event.gitBranch && !state.gitBranch) state.gitBranch = event.gitBranch;
  if (event.repoName && !state.repoName) state.repoName = event.repoName;
  if (state.cwd || state.repoName) {
    state.repo = deriveRepo(state.cwd, state.gitBranch, state.repoName);
  }
  if (event.transcriptPath && !state.transcriptPath) state.transcriptPath = event.transcriptPath;
  if (event.model && !state.model) state.model = event.model;

  // Timestamps.
  if (state.startedTs === undefined) state.startedTs = ts;
  else state.startedTs = Math.min(state.startedTs, ts);

  // Counters & rollups (always — cumulative facts).
  switch (event.kind) {
    case "prompt":
      state.turns++;
      if (isLatest) {
        state.lastPrompt = event.prompt;
        state.now = oneLine(event.prompt);
      }
      state.unresolvedError = false; // moved on to a new turn
      break;
    case "tool":
      state.toolCalls++;
      if (isLatest) state.now = describeTool(event);
      if (EDIT_TOOLS.has(event.tool)) {
        state.edits++;
        const fp = event.input?.file_path;
        if (fp) state.files[fp] = (state.files[fp] || 0) + 1;
      } else if (event.tool === "Bash") {
        state.bash++;
        const cmd = event.input?.command;
        if (cmd) {
          state.commands.push(cmd);
          if (state.commands.length > COMMANDS_CAP) {
            state.commands.splice(0, state.commands.length - COMMANDS_CAP);
          }
        }
      } else if (SUBAGENT_TOOLS.has(event.tool)) {
        state.subagents++;
      }
      break;
    case "tool_result":
      if (event.isError) {
        state.errors++;
        state.unresolvedError = true;
        state.lastError = renderError(event.response);
      }
      break;
    case "task_created":
      if (event.taskId) {
        state.tasks[event.taskId] = {
          subject: event.taskSubject,
          status: "open",
          createdTs: ts,
          completedTs: undefined,
        };
      }
      recomputeTasks(state);
      break;
    case "task_updated":
      if (event.taskId) {
        const t = state.tasks[event.taskId] || (state.tasks[event.taskId] = { subject: event.taskSubject, status: "open", createdTs: ts });
        if (t.status !== "done") t.status = event.taskStatus || t.status;
      }
      recomputeTasks(state);
      break;
    case "task_completed":
      if (event.taskId) {
        // Defensive: a completion for an unknown task creates it, no throw.
        const t = state.tasks[event.taskId] || (state.tasks[event.taskId] = { subject: event.taskSubject, status: "open", createdTs: ts });
        if (event.taskSubject && !t.subject) t.subject = event.taskSubject;
        t.status = "done";
        t.completedTs = ts;
      }
      recomputeTasks(state);
      break;
    case "subagent_stop":
      state.subagents++;
      break;
    case "notify":
      if (isLatest) state.now = "waiting for input/permission";
      break;
    case "summary":
      if (event.prompt) state.title = event.prompt;
      break;
    default:
      break;
  }

  // Status (newest-event-wins; older replays don't regress live state). A decision tool
  // (ExitPlanMode/AskUserQuestion) blocks for user input but arrives as a `tool` event — so
  // the latest such event becomes an "awaiting decision" state (status "waiting" → surfaces
  // as attention, and steerable now via the pane). Any other latest event clears it.
  if (isLatest) {
    if (event.kind === "tool" && DECISION_TOOLS.has(event.tool)) {
      state.awaitingDecision = event.tool === "ExitPlanMode" ? "plan" : "question";
      state.decisionOptions = decisionOptionsFrom(event);
      state.status = "waiting";
      state.now = state.awaitingDecision === "plan" ? "awaiting plan approval" : "awaiting your answer";
    } else {
      if (state.awaitingDecision) { state.awaitingDecision = false; state.decisionOptions = undefined; }
      if (STATUS_BY_KIND[event.kind]) state.status = STATUS_BY_KIND[event.kind];
    }
  }

  // Buffer — push every event, cap length (drill-down source).
  state.buffer.push(sanitize(event));
  if (state.buffer.length > BUFFER_CAP) {
    state.buffer.splice(0, state.buffer.length - BUFFER_CAP);
  }

  state.lastTs = Math.max(state.lastTs, ts);
  return state;
}

function recomputeTasks(state) {
  const entries = Object.values(state.tasks);
  state.tasksDone = entries.filter((t) => t.status === "done").length;
  state.tasksOpen = entries.length - state.tasksDone;
  // currentTask = most recent in_progress, else most recent open (by createdTs).
  const active = Object.entries(state.tasks)
    .filter(([, t]) => t.status !== "done")
    .sort((a, b) => (rank(b[1]) - rank(a[1])) || ((b[1].createdTs || 0) - (a[1].createdTs || 0)));
  state.currentTask = active.length ? active[0][1].subject : undefined;
}

function rank(t) {
  return t.status === "in_progress" ? 1 : 0;
}

// Recognize a git-worktree path. Worktree managers (e.g. Superset) lay worktrees out as
// `…/worktrees/<repo>/<branch…>` (branch may contain slashes, e.g. feat/x), so the
// path itself carries BOTH the real repo and the branch — no git/disk read needed.
// Returns { repo, branch? } or null. Pure, so live AND import both benefit.
export function parseWorktreePath(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).replace(/\/+$/, "").split("/").filter(Boolean);
  const i = parts.lastIndexOf("worktrees");
  if (i < 0 || i + 1 >= parts.length) return null;
  return { repo: parts[i + 1], branch: parts.slice(i + 2).join("/") || undefined };
}

// Build the `repo@branch` label. Precedence (most authoritative first):
//   repo:   explicit repoName (resolved from .git) → worktree-path repo → last cwd segment
//   branch: explicit gitBranch (transcript/.git)   → worktree-path branch → none
// The worktree-path source means a live worktree session shows repo@branch even though
// live hooks carry no gitBranch (the branch is in the path).
export function deriveRepo(cwd, gitBranch, repoName) {
  const wt = parseWorktreePath(cwd);
  const lastSeg = cwd ? (String(cwd).replace(/\/+$/, "").split("/").filter(Boolean).pop() || cwd) : undefined;
  const repo = repoName || (wt && wt.repo) || lastSeg;
  if (!repo) return undefined;
  const branch = gitBranch || (wt && wt.branch) || undefined;
  return branch ? `${repo}@${branch}` : repo;
}

function oneLine(s, max = 120) {
  if (!s) return undefined;
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// Option labels for a pending decision, used to route a `decide` directive. AskUserQuestion
// carries them in its input; a plan approval's choices aren't in the tool input (the collector
// maps plan intent + confirms against the pane), so it returns undefined there.
function decisionOptionsFrom(event) {
  if (event.tool !== "AskUserQuestion") return undefined;
  const qs = event.input?.questions;
  if (!Array.isArray(qs)) return undefined;
  const labels = qs.flatMap((q) => (Array.isArray(q?.options) ? q.options.map((o) => o?.label).filter(Boolean) : []));
  return labels.length ? labels : undefined;
}

function describeTool(event) {
  const t = event.tool || "tool";
  const i = event.input || {};
  if (EDIT_TOOLS.has(t) && i.file_path) return `${t} ${i.file_path}`;
  if (t === "Bash" && i.command) return `Bash: ${oneLine(i.command, 80)}`;
  if (t === "Read" && i.file_path) return `Read ${i.file_path}`;
  return `running ${t}`;
}

function renderError(resp) {
  if (resp == null) return "error";
  if (typeof resp === "string") return oneLine(resp, 200);
  try { return oneLine(JSON.stringify(resp), 200); } catch { return "error"; }
}

// ---------------------------------------------------------------------------
// View builders
// ---------------------------------------------------------------------------

// Tier-0 overview row. status "stale" is computed here, never stored.
export function buildOverviewRow(state, now) {
  const ageMs = now - state.lastTs;
  let status = state.status;
  if (status === "idle" && ageMs > STALE_MS) status = "stale";
  // A stale or ended session is never attention-worthy — an old error isn't something
  // to act on now. Attention only fires for currently-relevant sessions.
  const live = status !== "stale" && status !== "ended";
  return {
    sessionId: state.sessionId,
    repo: state.repo,
    title: state.title,
    status,
    lastTs: state.lastTs,
    ageMs,
    turns: state.turns,
    toolCalls: state.toolCalls,
    edits: state.edits,
    bash: state.bash,
    errors: state.errors,
    subagents: state.subagents,
    fileCount: Object.keys(state.files).length,
    tasksOpen: state.tasksOpen,
    tasksDone: state.tasksDone,
    currentTask: state.currentTask,
    now: state.now,
    hasSummary: !!state.summary,
    attention: live && (status === "waiting" || state.unresolvedError),
  };
}

// Tier-0/1 digest row. `events` is the caller-supplied window slice (the
// collector sources this from events.jsonl so long windows aren't truncated by
// the 300-cap buffer).
export function buildDigestRow(state, events) {
  const files = new Set();
  const commands = [];
  let prompts = 0, edits = 0, errors = 0, tasksCompleted = 0;
  for (const e of events) {
    switch (e.kind) {
      case "prompt": prompts++; break;
      case "tool":
        if (EDIT_TOOLS.has(e.tool)) { edits++; if (e.input?.file_path) files.add(e.input.file_path); }
        else if (e.tool === "Bash" && e.input?.command) commands.push(e.input.command);
        break;
      case "tool_result": if (e.isError) errors++; break;
      case "task_completed": tasksCompleted++; break;
    }
  }
  return {
    sessionId: state.sessionId,
    repo: state.repo,
    status: state.status,
    events: events.length,
    prompts,
    edits,
    errors,
    tasksCompleted,
    files: [...files],
    commands,
  };
}

// since parser: integer + optional unit s|m|h|d (default m). Returns ms.
export function parseSince(str, def = "30m") {
  const m = String(str ?? def).trim().match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) return parseSince(def);
  const n = parseInt(m[1], 10);
  const unit = (m[2] || "m").toLowerCase();
  const mult = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[unit];
  return n * mult;
}

// Detail view = full state minus the (large) buffer.
export function buildDetail(state) {
  const { buffer, ...rest } = state;
  return rest;
}
