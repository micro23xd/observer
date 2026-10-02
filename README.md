# observer

[![test](https://github.com/micro23xd/observer/actions/workflows/test.yml/badge.svg)](https://github.com/micro23xd/observer/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

**Observability and bounded steering for many parallel Claude Code sessions.**

When you run a dozen Claude Code sessions at once (one per worktree, one per ticket),
nobody can read all of those transcripts, human or agent. **observer** collects
every session's hook events, **reduces** them into a compact per-session rollup (status,
what it's doing now, files touched, errors, tasks, an optional LLM summary), and serves
that through a tiered REST + **MCP** API. You on the dashboard, or an oversight agent,
get a rolled-up picture first and drill down to raw transcripts only when needed.

It's built to be the eyes of a "chief of staff" agent such as
[Hermes](https://github.com/NousResearch/hermes-agent) or
[OpenClaw](https://github.com/openclaw/openclaw), but any MCP client, script, or human
with `curl` works the same way.

If you opt in, the oversight agent can also **steer** a live session: nudge it at a turn
boundary, inject context, answer a pending plan or question prompt, or block a specific
tool call. Every one of these levers is default-deny and audited.

- **Zero dependencies.** Node ≥ 20 built-ins only. No `npm install`, no build step,
  one long-lived process.
- **Nothing to change in Claude Code.** It uses standard `"type": "http"` hooks.
- **Attention-sorted overview.** Sessions that are erroring or waiting on you come first.
- **Tiered read surface** (Tier 0 overview → Tier 3 raw transcript), mirrored 1:1 as a
  remote **MCP server** at `POST /mcp`.
- **Live dashboard** with SSE, an ignore list, and steering controls.
- **Backfill** from existing `~/.claude/projects` transcripts. Imported history goes
  through the same reducer as live hooks.
- **Optional rolling summaries** via Vertex AI (Gemini). Without credentials it runs
  fully deterministic.

```
 Claude Code sessions ──hooks──► POST /events ─► normalize ─► reduce ─► per-session state
 ~/.claude transcripts ─import─►                                         │
                                                  ┌──────────────────────┴───────────────┐
                                                  ▼                                      ▼
                                        REST /api/*  +  POST /mcp               dashboard (GET /)
                                                  │
                                        oversight agent ──steer──► next hook / idle tmux pane
```

## Quickstart

```bash
git clone https://github.com/micro23xd/observer && cd observer
node collector.mjs                 # listens on 127.0.0.1:4000
```

Add the hooks to your **user-level** `~/.claude/settings.json` so every session reports
in. See [Hook installation](#hook-installation) for the full block. Then start any
Claude Code session and open <http://localhost:4000>.

```bash
curl -s localhost:4000/api/sessions | jq '.[0]'
curl -s -XPOST localhost:4000/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Optionally backfill history first, while the collector is **stopped**:

```bash
node import-claude.mjs             # or: npm run import   (--since 2026-01-01 to limit)
```

## Hook installation

Each hook POSTs its payload to the collector. The short `timeout` makes a dead collector
fail fast: Claude Code treats hook timeouts and connection errors as non-blocking.

```json
{
  "hooks": {
    "SessionStart":      [{ "hooks": [{ "type": "http", "url": "http://localhost:4000/events", "timeout": 5, "headers": { "Authorization": "Bearer <OBSERVER_TOKEN>" } }] }],
    "UserPromptSubmit":  [{ "hooks": [{ "type": "http", "url": "http://localhost:4000/events", "timeout": 5, "headers": { "Authorization": "Bearer <OBSERVER_TOKEN>" } }] }],
    "PreToolUse":        [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:4000/events", "timeout": 5, "headers": { "Authorization": "Bearer <OBSERVER_TOKEN>" } }] }],
    "PostToolUse":       [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:4000/events", "timeout": 5, "headers": { "Authorization": "Bearer <OBSERVER_TOKEN>" } }] }],
    "PostToolUseFailure":[{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:4000/events", "timeout": 5, "headers": { "Authorization": "Bearer <OBSERVER_TOKEN>" } }] }],
    "Notification":      [{ "hooks": [{ "type": "http", "url": "http://localhost:4000/events", "timeout": 5, "headers": { "Authorization": "Bearer <OBSERVER_TOKEN>" } }] }],
    "TaskCreated":       [{ "hooks": [{ "type": "http", "url": "http://localhost:4000/events", "timeout": 5, "headers": { "Authorization": "Bearer <OBSERVER_TOKEN>" } }] }],
    "TaskCompleted":     [{ "hooks": [{ "type": "http", "url": "http://localhost:4000/events", "timeout": 5, "headers": { "Authorization": "Bearer <OBSERVER_TOKEN>" } }] }],
    "Stop":              [{ "hooks": [{ "type": "http", "url": "http://localhost:4000/events", "timeout": 5, "headers": { "Authorization": "Bearer <OBSERVER_TOKEN>" } }] }],
    "SessionEnd":        [{ "hooks": [{ "type": "http", "url": "http://localhost:4000/events", "timeout": 5, "headers": { "Authorization": "Bearer <OBSERVER_TOKEN>" } }] }]
  }
}
```

- **The `headers` field is required whenever `OBSERVER_TOKEN` is set.** Without it,
  ingestion gets a `401` and sessions silently stop appearing. In dev mode (no token) you
  can drop it.
- Verify inside a session with `/hooks`. The entries show as `[User]`.
- `TaskCreated`/`TaskCompleted` only fire when the Tasks capability is active. If they
  never arrive, the task rollup stays empty and nothing else breaks.

## Read API (REST ↔ MCP)

| Tier | REST | MCP tool | Use |
| --- | --- | --- | --- |
| 0 | `GET /api/sessions` (`?active=1`) | `list_sessions` | overview rows: status, counters, "doing now", steerability; attention-sorted |
| 0/1 | `GET /api/digest?since=30m` | `recent_activity` | per-session activity in a window (`s\|m\|h\|d`) |
| 1 | `GET /api/session/:id` | `session_summary` | full rollup: files, tasks, last error, summary |
| 2 | `GET /api/session/:id/events?types=tool,tool_result&limit=150` | `session_events` | recent normalized events |
| 3 | `GET /api/session/:id/transcript` | `session_transcript` (bounded tail) | the raw `.jsonl`, for deep dives |
| — | `GET /stream` | — | SSE push of every normalized event |
| — | `POST /api/session/:id/summarize` | — | force a summary fold |

Write tools (steering): `steer_session`, `list_steers`, `cancel_steer`,
`request_control`, `release_control`. See [Steering](#steering-bounded-write-back).

[`docs/agent-guide.md`](docs/agent-guide.md) is an operating guide written
*for the oversight agent*: field semantics, a polling playbook, and when to steer. Drop it
into your agent's instructions.

### Connecting an agent over MCP

`POST /mcp` speaks stateless Streamable-HTTP JSON-RPC (no separate process). Register it
as a remote MCP server in your agent's host config. The exact schema varies by host;
this is the common shape:

```json
{
  "mcpServers": {
    "observer": {
      "type": "http",
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer <OBSERVER_TOKEN>" }
    }
  }
}
```

## Auth and remote access

Auth is by **bearer token per route, never by source IP.** A local reverse proxy
(e.g. `tailscale serve`) forwards remote requests to loopback, so `remoteAddress` can't
tell a remote agent from a local hook.

- With `OBSERVER_TOKEN` set, **every route except `GET /`** requires
  `Authorization: Bearer $OBSERVER_TOKEN`. That includes `POST /events`, so a peer can't
  spoof hooks or consume steering directives.
- `GET /` (the dashboard page) is tokenless. It carries no data. Its API calls are
  bearer-gated, and it prompts for the token once and keeps it in `localStorage` (the
  **token** button sets or clears it).
- The server **binds `127.0.0.1`** by default (`OBSERVER_HOST`), so nothing is exposed on
  the LAN.
- `OBSERVER_TOKEN` unset means all routes are open. Use this only for local development.

To let an agent on another machine read it, put an authenticated tunnel in front instead
of binding a public interface. With Tailscale, for example:

```bash
OBSERVER_TOKEN=$(openssl rand -hex 32) node collector.mjs
tailscale serve --bg localhost:4000     # → https://<machine>.<tailnet>.ts.net
```

See [SECURITY.md](SECURITY.md) for the recommended posture.

## Steering (bounded write-back)

`"type": "http"` hooks are synchronous, and Claude Code honors the hook's HTTP
**response body** as hook output. The collector already receives every hook at
`POST /events`, so it can answer with a steering directive instead of the bare ack. No
new hook wiring is needed.

| kind | delivered via | effect |
| --- | --- | --- |
| `context` | idle tmux pane, or `UserPromptSubmit` hook¹ | guidance injected into the next prompt (`additionalContext`) |
| `nudge` | idle tmux pane, or `Stop` hook¹ | the agent is about to finish a turn → redirected with your instruction (`decision:block`) |
| `decide` | live tmux pane | answers a pending **plan approval** (`accept`) or **AskUserQuestion** (option number or label) |
| `block_tool` | `PreToolUse` hook | a tool call is denied before it runs (`permissionDecision:deny`); scope with `tool_match` |

¹ Hook delivery of `context`/`nudge` is **off by default** (`OBSERVER_HOOK_STEERING`), in
favor of typing into the session's idle pane via the [tmux wrapper](#idle-pane-delivery-optional-tmux).
**If you don't use the wrapper, turn "hook delivery" on** (dashboard config bar or
`OBSERVER_HOOK_STEERING=on`). Otherwise these two kinds have no way to reach a session.
`block_tool` always uses its hook.

**Default-deny, three gates.** Nothing is delivered unless all three hold:

1. The **master switch** is on (default off).
2. The session's **mode** is `approval` or `autonomous` (default `off`), or the operator
   granted the agent **control** of it.
3. A matching directive is **armed**.

In autonomous mode `context`, `nudge` and `decide` auto-arm. `block_tool` **always**
needs explicit approval. Delivery is **one-shot**, and directives **expire** after a
TTL (default 15 min).

**Transparency.** Hook-delivered directives show a `systemMessage` banner in the steered
session. Pane-typed ones are prefixed `[observer]`. Every transition (create, arm,
deliver, expire, cancel, control request/grant/release) is appended to `steer.jsonl`
unredacted. A `Stop` nudge respects `stop_hook_active`, so it never piles onto a block
loop. A bug in the steering path can never block a session: `/events` falls back to
the plain ack.

**Control grants.** An agent can `request_control` of a session for a stated task. Only
the operator can grant it (dashboard or REST; there's deliberately no MCP grant tool).
A grant is scoped by a TTL and ends on `release_control` or a revoke.

**Configure it live** from the dashboard: the master switch and a pending-approval badge
in the header, a config bar (default mode, TTL, auto-arm kinds, hook delivery), and a
per-session mode selector with a directive queue (approve or cancel). The REST
equivalents:

```bash
H="Authorization: Bearer $OBSERVER_TOKEN"; J='content-type: application/json'; B=http://localhost:4000
curl -H "$H" -H "$J" -XPOST $B/api/steer/master -d '{"enabled":true}'
curl -H "$H" -H "$J" -XPOST $B/api/steer/mode   -d '{"sessionId":"<id>","mode":"autonomous"}'
curl -H "$H" -H "$J" -XPOST $B/api/steer        -d '{"sessionId":"<id>","kind":"nudge","text":"also add tests"}'
curl -H "$H" -XPOST $B/api/steer/<directiveId>/approve      # or /cancel
curl -H "$H" -XPOST $B/api/control/<grantId>/grant          # or /deny, /revoke
curl -H "$H" $B/api/steer                                   # snapshot
```

### Idle-pane delivery (optional, tmux)

Claude Code only fires hooks while a turn is active, so the hook path can't reach a
session sitting idle at its prompt. [`tmux/claude-steer.sh`](tmux/claude-steer.sh) fixes
that. Use it in place of `claude`: it runs the real binary inside a dedicated,
invisible tmux server (`tmux -L observer`, configured by
[`tmux/observer.tmux.conf`](tmux/observer.tmux.conf)) and registers the pane with the
collector. The collector can then `send-keys` a directive into an idle session, or
answer a plan/question prompt with `decide`.

```bash
alias claude=/path/to/observer/tmux/claude-steer.sh
```

It works from any terminal and is also usable as the agent command of a launcher such as
Superset. Every step is best-effort: without tmux, curl, or a running collector, it just
`exec`s `claude` as usual (you only lose idle-pane steering for that session). The
session's `steer.reach` field shows `live-pane` once its pane is registered.

## Configuration

| Var | Default | Meaning |
| --- | --- | --- |
| `OBSERVER_PORT` | `4000` | listen port |
| `OBSERVER_HOST` | `127.0.0.1` | bind address |
| `OBSERVER_TOKEN` | unset | bearer token for every route except `GET /`; unset = open (dev mode) |
| `OBSERVER_DATA_DIR` | `~/.observer` | where state, logs and runtime config live |
| `OBSERVER_ROTATE_BYTES` | `67108864` (64 MB) | rotate `events.jsonl` at this size |
| `OBSERVER_ROTATE_KEEP` | `3` | rotated log files to retain |
| `OBSERVER_PRUNE_MS` | `604800000` (7 d) | prune ended/idle sessions older than this |
| `OBSERVER_IGNORE` | unset | comma-separated repos/paths to hide from discovery (**seed**) |
| `OBSERVER_STEERING` | `off` | steering master switch (**seed**) |
| `OBSERVER_STEER_DEFAULT_MODE` | `off` | default per-session mode: `off`/`approval`/`autonomous` (**seed**) |
| `OBSERVER_STEER_TTL_MS` | `900000` (15 m) | directive TTL (**seed**) |
| `OBSERVER_STEER_AUTO_KINDS` | `context,nudge,decide` | kinds that auto-arm in autonomous mode; `block_tool` never does (**seed**) |
| `OBSERVER_HOOK_STEERING` | `off` | also deliver nudge/context via the hook response; off prefers the idle pane (**seed**) |
| `GOOGLE_APPLICATION_CREDENTIALS` | unset | Vertex service-account JSON; enables summaries |
| `VERTEX_PROJECT` | key's `project_id` | GCP project for Vertex |
| `VERTEX_LOCATION` | `global` | Vertex location/region |
| `OBSERVER_MODEL` | `gemini-3.1-flash-lite` | Vertex summary model |
| `CLAUDE_DIR` | `~/.claude/projects` | importer source |
| `OBSERVER_URL` / `OBSERVER_TMUX_SERVER` | `http://localhost:4000` / `observer` | used by `tmux/claude-steer.sh` |

**Seed** variables only take effect at boot. The dashboard and REST edits are
authoritative, are persisted (`ignore.json`, `steer.json`) and survive restarts, so you
never need to restart to change steering or the ignore list.

### Ignore list

Hide noisy repos from the discovery surfaces (`/api/sessions`, `/api/digest`, and the
`list_sessions`/`recent_activity` tools). Matching is by repo name (case-insensitive) or
cwd substring, so all worktrees of a repo are covered. A session requested directly by id
is still returned. Manage it from the dashboard (ignore bar and the per-row ⊘ button) or
via REST:

```bash
curl -H "Authorization: Bearer $OBSERVER_TOKEN" -H 'content-type: application/json' \
  -XPOST localhost:4000/api/ignore -d '{"add":["scratch"],"remove":["keep-this"]}'
```

### Summaries (optional, Vertex AI)

Per-session rolling summaries are folded incrementally at each `Stop`. To enable them,
create a service account with the **Vertex AI User** role (`roles/aiplatform.user`),
download a JSON key, and:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json VERTEX_PROJECT=my-gcp-project node collector.mjs
```

The collector signs the JWT itself with Node's `crypto`, exchanges it for a short-lived
token, and caches it. It doesn't need `gcloud` or an SDK. If the model returns 404, set
`VERTEX_LOCATION` to a region that serves it.

## How it works

Everything is one pipeline, **normalize → reduce → view**:

- **`core.mjs`** is the pure heart. `normalizeHookEvent` (live) and
  `normalizeTranscriptLine` (import) emit the *same* `NormalizedEvent`, and both go
  through the *same* `reduce()`. Counters are cumulative and order-tolerant. `status` and
  "now" are newest-event-wins, so a replayed old `SessionEnd` can't end a live session.
- **`collector.mjs`** is the service: HTTP, persistence, SSE, ignore list, the steering
  store, and the embedded dashboard. Side effects that `reduce()` deliberately omits
  (LLM folds, steering delivery) live here.
- **`steer.mjs`** holds the pure steering decisions: gating, matching, TTL, and rendering
  a directive to hook-output JSON or pane keystrokes.
- **`mcp.mjs`** is the transport-agnostic JSON-RPC/MCP layer over the same view builders
  REST uses.
- **`gitinfo.mjs`** resolves `repo@branch` for plain checkouts by reading `.git` on disk.
  Worktree paths (`…/worktrees/<repo>/<branch>`) are parsed string-side.
- **`vertex.mjs`** is the one LLM touchpoint: service-account JWT → OAuth → `generateContent`.
- **`import-claude.mjs`** is the one-shot backfill. It reduces per session, downgrades
  historical active sessions to `idle`, and merges into `state.json` without clobbering
  a session the running collector still owns.

**Persistence** (in `OBSERVER_DATA_DIR`):

- `state.json` holds rollups, written atomically every ~15 s and on SIGINT/SIGTERM.
- `events.jsonl` is the append-only event log, rotated by size. The per-session drill-down
  buffers are rehydrated from it on boot.
- `ignore.json` and `steer.json` are the runtime config.
- `steer.jsonl` is the steering audit log.

## Development

```bash
node --test                                   # all tests (npm test)
node --test core.test.mjs                     # one file
node --test --test-name-pattern "attention"   # by name
```

Tests are colocated `*.test.mjs` files that use `node:test`. They run offline and write
only to temp dirs. tmux-based tests skip themselves when tmux isn't installed. The
integration suite covers the acceptance criteria: reducer correctness, attention sort,
digest window, drill-down filter, auth, timeout safety, importer merge, summary
optionality, and graceful task degradation, plus the steering security model.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the ground rules (zero deps, one reducer) and
[ROADMAP.md](ROADMAP.md) for what's next.

## License

[MIT](LICENSE)
