# Contributing

Thanks for taking a look. hermes-observer is small on purpose, so a few ground rules
keep it that way.

## Ground rules

- **Zero runtime dependencies.** Node ≥ 20 built-ins only (`http`, `fetch`, `crypto`,
  `readline`, …). No `npm install`, no build step. If a change seems to need a package,
  open an issue first.
- **One reducer, two sources.** Live hooks (`normalizeHookEvent`) and imported transcripts
  (`normalizeTranscriptLine`) both emit the same `NormalizedEvent` and go through the same
  `reduce()` in `core.mjs`. Don't fork the reducer per source, and keep `reduce()` pure —
  side effects (LLM folds, steering delivery, I/O) belong in `collector.mjs`.
- **Newest-event-wins for status.** Counters are cumulative and order-tolerant; `status`,
  `now` and `lastPrompt` only move on the latest event, so replays can't regress a live
  session.
- **Default-deny steering.** Anything that writes back into a session must stay behind the
  master switch + per-session mode + armed-directive gates. See [SECURITY.md](SECURITY.md).
- **Runtime config beats env.** Env vars seed knobs at boot; dashboard/REST edits are
  authoritative and persisted. Don't add env-only knobs.

[CLAUDE.md](CLAUDE.md) has a module map and the full list of invariants.

## Development

```bash
node collector.mjs                                    # run the service on :4000
node --test                                           # all tests
node --test core.test.mjs                             # one file
node --test --test-name-pattern "attention" core.test.mjs
```

Tests are colocated (`*.test.mjs`, `node:test`), write only to temp dirs, and run
offline. The few tmux-based tests skip themselves when tmux isn't installed.

## Pull requests

- Keep them focused; add or update a test for behavior changes.
- `node --test` must pass on Node 20+.
- Update the README / `docs/hermes-agent-guide.md` when you change an endpoint, an MCP
  tool, or an env var — the REST and MCP surfaces are meant to mirror each other.
