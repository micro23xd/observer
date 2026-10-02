// mcp.mjs — Model Context Protocol layer for the oversight agent (zero deps).
//
// Pure protocol: handleMcpMessage(msg, api) turns one JSON-RPC 2.0 message into a
// response object (or null for notifications). It is transport- and storage-agnostic —
// `api` is an injected bag of async data-access functions, so this is unit-testable
// without a server. The collector wires it to POST /mcp; tools call the same in-memory
// view builders the REST routes use.

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "observer", version: "0.1.0" };

// Read tiers (list_sessions … session_transcript) plus the steering/control write tools,
// mirroring docs/agent-guide.md. Descriptions teach the agent the tiered-access
// discipline (cheap → deep) and the steering guardrails.
export const TOOLS = [
  {
    name: "list_sessions",
    description:
      "Tier 0. Overview of every coding session, sorted attention-first then most-recent. " +
      "Start here. Returns status, counters, current activity, task rollup, and an attention hint per session. " +
      "Pass active_only:true to skip stale/ended sessions and see only what's currently live. " +
      "Each row also carries a `steer` object — whether you can steer it and why. Its three axes: " +
      "`reach` (live-pane = a terminal you can type into even while idle | hook-only | unreachable | ended), " +
      "`permission` (off | approval | autonomous | controlled), and the net `canSteer` (true ⇒ a directive will land) " +
      "with `deliverWhen` (now | when-idle | next-hook) or `why` (the reason it can't). Note: a long-idle ('stale') " +
      "session with reach=live-pane is FULLY steerable — staleness is just age, not a blocker. " +
      "If `steer.awaitingDecision` is 'plan' or 'question', the agent is BLOCKED on an interactive prompt " +
      "(plan approval / a question) — answer it with a `decide` directive (see steer_session); " +
      "`steer.decisionOptions` lists the choices when known.",
    inputSchema: {
      type: "object",
      properties: { active_only: { type: "boolean", description: "omit stale/ended sessions" } },
      additionalProperties: false,
    },
  },
  {
    name: "recent_activity",
    description:
      "Tier 0/1. What changed in a time window. `since` is like 30m, 2h, 1d (default 30m). " +
      "Returns per-session edits, errors, files, commands, and tasks completed in the window. Sessions idle in the window are omitted.",
    inputSchema: {
      type: "object",
      properties: { since: { type: "string", description: "window: <int><s|m|h|d>, e.g. 30m, 2h, 1d" } },
      additionalProperties: false,
    },
  },
  {
    name: "session_summary",
    description:
      "Tier 1. Full rolled-up state for one session: counters, files touched, tasks, last error, and the rolling summary. " +
      "Use after list_sessions flags something worth a closer look.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "session_events",
    description:
      "Tier 2. Recent raw events for one session (newest last). The drill-down level — actual prompts, file paths, commands, errors. " +
      "Optionally filter `types` (comma-separated event kinds like prompt,tool,tool_result OR tool names like Edit,Bash). `limit` default 150.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        types: { type: "string", description: "csv of event kinds or tool names" },
        limit: { type: "number" },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "session_transcript",
    description:
      "Tier 3. The raw transcript for one session — your deep-context escape hatch. Expensive; use only when the other tools " +
      "can't answer the question. Returns the last `max_bytes` of the transcript (default 65536) to avoid flooding context.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, max_bytes: { type: "number" } },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  // ── Write tools: bounded steering. These ACT on a session (the only non-read tools).
  // All are gated server-side by the master switch + per-session mode; a disabled or
  // non-steerable target returns an isError result explaining why.
  {
    name: "steer_session",
    description:
      "WRITE. Queue a steering directive for one session — your only way to act, not just observe. " +
      "kind: 'nudge' (redirect the agent at its next turn end via the Stop hook — the main lever), " +
      "'context' (inject guidance into the user's next prompt; soft, lands when they next type), " +
      "'decide' (ANSWER an interactive decision prompt when steer.awaitingDecision is set — text is the " +
      "choice: 'accept' for a plan, or an option number/label for a question; delivers immediately), or " +
      "'block_tool' (deny a tool call before it runs; pass tool_match like 'Bash' to scope it). " +
      "Returns {id, status, reach, willDeliver, deliverWhen, note?}: status 'armed' = it will deliver, " +
      "'proposed' = awaiting operator approval (approval-mode sessions, and block_tool always). Check `reach` " +
      "and `willDeliver`: an armed directive to a session with no live pane is QUEUED, not lost — it lands when " +
      "the session next becomes reachable, else expires at its TTL (`note` explains). For idle steering the target " +
      "needs reach=live-pane (see list_sessions). Delivery is one-shot. Steering must be enabled (master switch) " +
      "and the session permitted (a mode, or an active control grant), or this errors with the reason.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        kind: { type: "string", description: "nudge | context | decide | block_tool" },
        text: { type: "string", description: "the instruction / context / reason shown to the agent" },
        tool_match: { type: "string", description: "block_tool only: restrict to this tool name (e.g. Bash)" },
        ttl_ms: { type: "number", description: "override expiry in ms (default 15m)" },
      },
      required: ["session_id", "kind", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "list_steers",
    description:
      "WRITE-surface read. List steering directives you (or the operator) have queued, with their status " +
      "(proposed/armed/delivered/expired/cancelled). Pass session_id to scope to one session. Use it to see " +
      "whether a nudge has landed yet or is still awaiting approval.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "cancel_steer",
    description:
      "WRITE. Retract a steering directive by id before it's delivered (e.g. you changed your mind, or it's no " +
      "longer relevant). Returns the updated directive. No-op if it was already delivered/expired.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "request_control",
    description:
      "WRITE. Ask the operator to let you TAKE CONTROL of a task on one session and drive it autonomously via " +
      "idle steering. This only REQUESTS — you can never grant yourself control; the operator must approve " +
      "(in the dashboard). Once granted, control is scoped: it ends at a TTL, when you mark the " +
      "task done (release_control), or if the operator revokes. While granted, your context/nudge directives " +
      "auto-arm and deliver (block_tool still needs per-action approval). Returns {id, status}: 'requested' " +
      "means awaiting the operator; poll session_summary's `control` field to see when it flips to 'granted'. " +
      "Use sparingly and only when finishing the task yourself is clearly better than nudging.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        task: { type: "string", description: "what you want to take over and finish — shown to the operator verbatim" },
        ttl_ms: { type: "number", description: "requested control window in ms (default 30m); the operator may shorten it" },
      },
      required: ["session_id", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "release_control",
    description:
      "WRITE. Give control back when the task is done (or you no longer need it). Ends your active or pending " +
      "control grant for the session. Always safe — releasing never requires approval. Returns the ended grant, " +
      "or nothing if you held none.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
];

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

// Returns a JSON-RPC response object, or null for notifications (which get no reply).
export async function handleMcpMessage(msg, api) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;
  const hasId = id !== undefined && id !== null;
  if (typeof method !== "string") return hasId ? fail(id, -32600, "invalid request") : null;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications: no response
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments || {};
      // Tool execution errors are returned as isError results (so the agent sees them),
      // not JSON-RPC errors.
      try {
        return ok(id, { content: [{ type: "text", text: await dispatch(name, args, api) }] });
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      return hasId ? fail(id, -32601, `method not found: ${method}`) : null;
  }
}

function reqArg(args, key) {
  const v = args[key];
  if (v === undefined || v === null || v === "") throw new Error(`missing required argument: ${key}`);
  return v;
}

async function dispatch(name, args, api) {
  switch (name) {
    case "list_sessions":
      return JSON.stringify(await api.sessions({ activeOnly: !!args.active_only }));
    case "recent_activity":
      return JSON.stringify(await api.digest(args.since));
    case "session_summary": {
      const d = await api.session(reqArg(args, "session_id"));
      if (d === null) throw new Error(`no such session: ${args.session_id}`);
      return JSON.stringify(d);
    }
    case "session_events": {
      const ev = await api.sessionEvents(reqArg(args, "session_id"), args.types, args.limit);
      if (ev === null) throw new Error(`no such session: ${args.session_id}`);
      return JSON.stringify(ev);
    }
    case "session_transcript": {
      const t = await api.transcriptText(reqArg(args, "session_id"), args.max_bytes);
      if (t === null) throw new Error(`no transcript on disk for session: ${args.session_id}`);
      return t.truncated ? `[truncated to last ${t.bytes} bytes of transcript]\n${t.text}` : t.text;
    }
    case "steer_session": {
      // api.steerCreate throws on disabled/non-steerable/bad-kind → surfaces as isError.
      // On success it returns {id, status, reach, willDeliver, deliverWhen, note?}.
      const d = await api.steerCreate({
        sessionId: reqArg(args, "session_id"),
        kind: reqArg(args, "kind"),
        text: reqArg(args, "text"),
        toolMatch: args.tool_match,
        ttlMs: args.ttl_ms,
        by: "agent",
      });
      return JSON.stringify(d);
    }
    case "list_steers":
      return JSON.stringify(await api.steerList(args.session_id));
    case "cancel_steer": {
      const d = await api.steerCancel(reqArg(args, "id"));
      if (d === null) throw new Error(`no such directive: ${args.id}`);
      return JSON.stringify(d);
    }
    case "request_control": {
      const g = await api.controlRequest({
        sessionId: reqArg(args, "session_id"),
        task: reqArg(args, "task"),
        ttlMs: args.ttl_ms,
      });
      return JSON.stringify({ id: g.id, status: g.status, sessionId: g.sessionId, task: g.task });
    }
    case "release_control": {
      const g = await api.controlRelease(reqArg(args, "session_id"));
      if (g === null) return JSON.stringify({ released: false, reason: "no active or pending control grant" });
      return JSON.stringify({ released: true, id: g.id, status: g.status });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
