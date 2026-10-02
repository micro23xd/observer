# Security

observer sees everything your Claude Code sessions do (prompts, commands, file
paths, transcripts) and — if you enable steering — can **write back into live sessions**.
Treat it like a privileged local service.

## Recommended posture

- **Set `OBSERVER_TOKEN`** (e.g. `openssl rand -hex 32`) whenever anything other than your
  own local hooks can reach the port. With a token set, every route except the static
  dashboard page requires `Authorization: Bearer <token>` — including `POST /events`, so a
  peer can't spoof hooks or consume steering directives.
- **Keep the loopback bind** (`OBSERVER_HOST=127.0.0.1`, the default). For remote access,
  put an authenticated tunnel or reverse proxy in front (e.g. `tailscale serve`) rather
  than binding a public interface. Auth is by bearer token, never by source IP, because a
  local reverse proxy makes every request look like it comes from loopback.
- **Leave steering off unless you need it.** It is default-deny: the master switch, the
  per-session mode, and an armed directive must all line up before anything is delivered.
  `block_tool` never auto-arms. Every steering transition is appended (unredacted) to
  `steer.jsonl` in the data directory.
- The data directory (`~/.observer` by default) contains session state, a raw event
  log, and — when a token is set — a `0600` token file for the local tmux launch wrapper.
  Protect it accordingly.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, and include steps to reproduce. I'll acknowledge within a few days.
