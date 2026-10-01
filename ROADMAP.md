# Roadmap

Ideas that are scoped but not built yet. Contributions welcome — open an issue first for
anything non-trivial.

## Live == import parity test

**What:** In `core.test.mjs`, feed equivalent activity through `normalizeHookEvent`
(hook path) and `normalizeTranscriptLine` (transcript path), reduce both, and assert the
resulting per-session state is deep-equal.

**Why:** `core.mjs` is shared between the live collector and the importer on the premise
that both paths reduce to identical state. Nothing tests that invariant directly yet — if
the two normalizers drift, the dashboard silently shows wrong data.

**Where to start:** build a fixture of one logical session (prompt → Edit → Bash →
failure → task create/complete) expressed once as hook payloads and once as transcript
lines; normalize + reduce each; `assert.deepEqual` the two states, excluding fields that
only one source provides (e.g. `gitBranch`, `transcriptPath`).

## Steering: opt-in autonomous `block_tool`

**What:** `block_tool` directives are always `proposed` (need operator approval), even on
autonomous sessions — enforced in `initialStatus()` in `steer.mjs` and filtered out of
`autoKinds`. Add a separate, explicit opt-in (e.g. a per-session `allowAutoBlock` flag) so a
fully-trusted session can let the oversight agent deny tool calls without a human in the
loop.

**Why:** `block_tool` is the only lever that *denies* an action, so it's approval-gated by
default. Power users running a known-safe autonomous setup may want real-time blocking.

## Steering: rate limiting and metrics

**What:** Beyond the per-session queue cap (10 active directives), add a delivery rate
limit (max N deliveries per session per hour) and surface steering metrics (deliveries,
expiries, approval latency) in the dashboard and a `/api/steer/stats` endpoint.

**Why:** The queue cap bounds memory, not delivery frequency. A misbehaving autonomous
policy could nudge a session every turn; a rate limit plus visible metrics makes runaway
steering obvious and self-limiting.

## Search layer

SQLite + FTS5 (built-in `node:sqlite` on Node 22+) for structured and keyword search over
normalized event text (prompts, commands, file paths, errors, summaries) — not full file
bodies. This would replace the hand-rolled `events.jsonl` rotation / boot rehydrate /
digest-scans-the-log machinery with indexed queries, leaving `core.mjs` untouched.
Semantic / vector search is intentionally out of scope: that judgment layer belongs on
the oversight-agent side. Open trade-off: `node:sqlite` (experimental on 22.x) vs
`better-sqlite3` (solid, but breaks the zero-dependency rule).
