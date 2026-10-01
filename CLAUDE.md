# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`hermes-observer` is an observability service for many parallel Claude Code sessions.
Claude Code hooks POST every lifecycle event to the collector, which **reduces** them
into per-session rollup state. An oversight agent ("Hermes") reads tiered views over the
tailnet and can optionally **steer** live sessions back. Despite the repo name
(`claude-collector`), the product/package name is `hermes-observer`.

Zero runtime dependencies (Node ≥ 20 built-ins only — `http`, `fetch`, `crypto`,
`readline`). No `npm install`. Single long-lived process.

## Commands

```bash
node collector.mjs          # start the service (npm start)
node import-claude.mjs       # one-shot backfill from ~/.claude transcripts (npm run import)
                             # run while the collector is STOPPED
node --test                  # run all tests (npm test)
node --test core.test.mjs    # run one test file
node --test --test-name-pattern "attention" core.test.mjs   # one test by name
```

Quick MCP smoke check (dev mode, no token):
```bash
curl -s -XPOST http://localhost:4000/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Architecture

The whole system is a pipeline: **normalize → reduce → view**. Two input sources, one
reducer.

```
live hook (POST /events) ─┐
                          ├─► normalize* → NormalizedEvent → reduce(state, event) → per-session state
imported transcript line ─┘                                      │
                                                                 └─► view builders (overview / digest / detail)
```

### Module map
- **`core.mjs`** — the pure heart. `normalizeHookEvent` / `normalizeTranscriptLine` both
  emit the SAME `NormalizedEvent` shape, then both go through the SAME `reduce()`. This
  identical-reduction invariant is the single most important rule — **do not fork the
  reducer per source.** `reduce()` is pure (mutates state in place, no I/O, schedules no
  side effects). Also holds `parseWorktreePath`/`deriveRepo` (repo@branch labels) and the
  view builders (`buildOverviewRow`, `buildDigestRow`, `buildDetail`, `parseSince`).
- **`collector.mjs`** — the service: HTTP server, persistence, SSE, ignore list, steering
  store, and the embedded dashboard HTML. Side effects that `reduce()` deliberately omits
  (e.g. the LLM summary fold on `Stop`) live here in `ingestHook`/`scheduleFold`.
- **`steer.mjs`** — pure decision brain for write-back. `selectDirective` (gating + match
  + FIFO + TTL) and `renderResponse` (directive → exact hook-output JSON). No I/O; the
  collector owns the store and side effects.
- **`mcp.mjs`** — pure JSON-RPC 2.0 / MCP layer. `handleMcpMessage(msg, api)` is
  transport- and storage-agnostic; `api` is an injected bag of data-access functions, so
  the same in-memory view builders back both REST and MCP.
- **`gitinfo.mjs`** — fallback `.git`-on-disk repo/branch resolver (memoized) for *plain*
  checkouts only. Worktree paths are resolved string-side in `core.parseWorktreePath`
  with no disk I/O.
- **`vertex.mjs`** — the one LLM touchpoint. Service-account JWT → OAuth token → Vertex
  `generateContent`. `fetch` and clock are injectable for offline tests.
- **`import-claude.mjs`** — one-shot backfill; groups transcript events by session,
  reduces per session, downgrades historical active sessions to `idle`, merges into
  `state.json` without clobbering a live session.
- **`tmux/claude-steer.sh` + `tmux/hermes.tmux.conf`** — optional launch wrapper that runs
  `claude` inside a dedicated tmux server and registers the pane (`POST /api/steer/pane`)
  so the collector can type directives into idle sessions (`send-keys`).

### Key invariants (respect these when editing)
- **One reducer, two sources.** Anything you add to reduction must work identically for
  live hooks and imported transcripts. Side effects never go in `reduce()`.
- **Newest-event-wins for status.** Counters/tasks/files are cumulative and
  order-tolerant; `status`/`now`/`lastPrompt` apply only when the event is the latest
  seen (`isLatest`), so a replayed older `SessionEnd` can't mark a live session ended.
- **Auth is by ROUTE, never source IP.** `tailscale serve` reverse-proxies tailnet peers
  to loopback, so `remoteAddress` can't distinguish Hermes from a local hook. `POST
  /events` is therefore bearer-gated too (when `HERMES_TOKEN` is set) — an open `/events`
  would let any tailnet peer spoof hooks and consume steering directives. `GET /`
  (dashboard) is the only tokenless route and binds `127.0.0.1`.
- **Ingest is fully non-blocking and defensive.** `POST /events` always responds (steer
  JSON or bare ack); a bug in the steering path can never block a session. Reduction is
  synchronous in arrival order; only the LLM fold defers.
- **Default-deny steering.** Nothing delivers unless master switch is on AND the session's
  mode is `approval`/`autonomous` AND a matching directive is `armed`. `block_tool` never
  auto-arms. Delivery is one-shot; directives expire after a TTL.
- **Runtime config beats env.** For both the ignore list (`ignore.json`) and steering
  (`steer.json`), env vars are **boot seeds only**; dashboard/REST edits are authoritative
  and survive restart. Never make a knob env-only.

## Tiered read surface (REST + MCP mirror each other)
| Tier | REST | MCP tool |
| --- | --- | --- |
| 0 | `GET /api/sessions` | `list_sessions` |
| 0/1 | `GET /api/digest?since=30m` | `recent_activity` |
| 1 | `GET /api/session/:id` | `session_summary` |
| 2 | `GET /api/session/:id/events` | `session_events` |
| 3 | `GET /api/session/:id/transcript` (raw .jsonl) | `session_transcript` (bounded tail) |

Write tools (steering): `steer_session`, `list_steers`, `cancel_steer`. Plus `GET /stream`
(SSE) and `POST /api/session/:id/summarize`. The MCP endpoint is `POST /mcp` (Streamable
HTTP, stateless JSON-RPC) — no separate process.

## Persistence (in `HERMES_DATA_DIR`, default `~/.hermes-observer`)
- `state.json` — rollups; atomic temp+rename every ~15s and on signal. Buffers are NOT
  persisted here.
- `events.jsonl` — append-only durable log, rotated by size; per-session ring buffers
  (cap `BUFFER_CAP=300`) rehydrate from it on boot.
- `ignore.json` / `steer.json` — runtime config overlays. `steer.jsonl` — append-only,
  unredacted audit of every steering transition.

## Testing conventions
Each module has a colocated `*.test.mjs` using `node:test`. Pure modules (`core`,
`steer`, `mcp`, `gitinfo`, `vertex`) test fully offline — `vertex` injects `fetch`/clock,
`gitinfo` exposes `_clearCache()` as a test seam. The README lists the acceptance
criteria the suite covers (reducer correctness, attention sort, digest window, auth,
timeout safety, importer merge, summary optionality, graceful task degradation).

## Optional summaries
Per-session rolling summaries fold incrementally at each `Stop` via Vertex AI. Entirely
optional: with no `GOOGLE_APPLICATION_CREDENTIALS`, the service runs deterministic-only
and `summary` stays `null`. See README "Configuration" for the full var table.
