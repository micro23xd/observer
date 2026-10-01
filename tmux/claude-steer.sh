#!/bin/bash
# claude-steer.sh — launch wrapper that makes a Claude Code session externally
# steerable by hermes-observer, *including while it sits idle*.
#
# WHY: Claude Code fires hooks only while a turn is active, so the collector can't
# deliver a steering directive to an idle session through the hook response. Running
# claude inside a dedicated tmux server gives the collector an addressable PTY it can
# type into with `tmux send-keys` — which we proved wakes an idle session.
#
# WIRING: run it instead of `claude` (same args), e.g. `alias claude=/path/to/claude-steer.sh`,
# or point your launcher's agent command at it. In Superset: Settings → Agents → (your
# Claude row) → "command". Superset's SUPERSET_* env is used when present, never required.
# We re-exec the real claude under a dedicated tmux server.
#
# SAFETY: every step here is best-effort and MUST NOT block or break the session. No tmux,
# no curl, or a dead collector all fall through to launching claude exactly as before —
# you just lose idle-steering for that session, nothing else.

set -u

HERMES="${HERMES_URL:-http://localhost:4000}"
TMUX_SERVER="${HERMES_TMUX_SERVER:-hermes}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$SELF_DIR/hermes.tmux.conf"

# Resolve the REAL claude binary — skip Superset's shim/wrapper dirs and our own dir so
# we don't recurse into ourselves or back into the shim.
find_real_claude() {
  local IFS=: dir
  for dir in $PATH; do
    [ -z "$dir" ] && continue
    dir="${dir%/}"
    case "$dir" in
      *"/.superset/bin"|*"/.superset/wrappers"|*"/.superset-"*|"$SELF_DIR") continue ;;
    esac
    if [ -x "$dir/claude" ] && [ ! -d "$dir/claude" ]; then
      printf '%s\n' "$dir/claude"; return 0
    fi
  done
  return 1
}
REAL="$(find_real_claude)" || REAL="claude"

# Degrade gracefully: without tmux we can't offer idle-steering — just run claude.
if ! command -v tmux >/dev/null 2>&1; then
  exec "$REAL" "$@"
fi

# A unique, mappable tmux session name. The collector correlates this pane with claude's
# own session_id by joining on cwd (claude's SessionStart hook carries the same cwd), so
# the name only needs to be unique and stable for this process.
WS="${SUPERSET_WORKSPACE_NAME:-$(basename "$PWD")}"
SAFE_WS="$(printf '%s' "$WS" | tr -c 'A-Za-z0-9_-' '_')"
SESS="${SAFE_WS}-$$"

# Canonical (physical) cwd — claude reports process.cwd() resolved, so we register the same
# realpath to keep the join symlink-safe (e.g. /tmp vs /private/tmp on macOS).
CWD_P="$(pwd -P 2>/dev/null || printf '%s' "$PWD")"

# Bearer token: /api/steer/pane is gated. Launchers often do NOT export HERMES_TOKEN into
# the session env, so fall back to the 0600 token file the collector drops in its data dir.
TOKEN="${HERMES_TOKEN:-}"
TOKEN_FILE="${HERMES_DATA_DIR:-$HOME/.hermes-observer}/token"
[ -z "$TOKEN" ] && [ -r "$TOKEN_FILE" ] && TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null)"

# Minimal JSON string escaping (backslash, then double quote) so an odd cwd or workspace
# name can't produce an invalid body.
json_esc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }

# Tell the collector where to type. Fire-and-forget, 1s cap, errors ignored — never let
# a slow/absent collector delay the user's session. SUPERSET_TERMINAL_ID is passed along
# as a stable secondary key when present (seen in Superset's own agent wrappers).
curl -fsS -m 1 -X POST "$HERMES/api/steer/pane" \
  ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
  -H 'content-type: application/json' \
  -d "{\"cwd\":\"$(json_esc "$CWD_P")\",\"server\":\"$(json_esc "$TMUX_SERVER")\",\"target\":\"$SESS\",\"workspace\":\"$(json_esc "$WS")\",\"terminalId\":\"$(json_esc "${SUPERSET_TERMINAL_ID:-}")\"}" \
  >/dev/null 2>&1 &

# Config is only read when the server FIRST starts (the -f below). Re-apply it to an
# already-running server so edits to hermes.tmux.conf propagate to new sessions without a
# server restart — its options are all global/idempotent, so re-sourcing is safe.
tmux -L "$TMUX_SERVER" source-file "$CONF" >/dev/null 2>&1 || true

# Hand the terminal to claude, nested in tmux. `-A -s` attaches-or-creates; with a unique
# name it always creates. exec so claude owns the process (Superset sees normal lifecycle).
exec tmux -L "$TMUX_SERVER" -f "$CONF" new-session -A -s "$SESS" -- "$REAL" "$@"
