#!/bin/sh
# agentnet-join.sh <name> <job> [project]
# A long-lived channel bot joins the agent network: POST /agentnet/spawn (optional root token file, boss root) and print `export` lines for the
# launcher to eval. Prints nothing and exits 1 when the service does not answer or refuses, so the launcher can start the bot
# without agentnet (fail-safe). The token itself is never printed, only the path of its 0600 file.
#   an="$(agentnet-join.sh mybot 'My bot' "$PWD")" && eval "$an" && set -- --plugin-dir "$AGENTNET_MOD"
# Env overrides: AGENTNET_URL AGENTNET_ROOT_TOKEN_FILE AGENTNET_MOD_DIR AGENTNET_BOSS.
LOG="${AGENTNET_JOIN_LOG:-${AGENTNET_HOME:-$HOME/.local/share/agentnet}/logs/agentnet-join.log}"
fail() { mkdir -p "$(dirname "$LOG")" 2>/dev/null; printf '%s %s: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "${name:-?}" "$1" >> "$LOG" 2>/dev/null; echo "agentnet: not joined ($1)" >&2; exit 1; }
name="$1"; job="${2:-channel bot}"; project="${3:-$PWD}"
url="${AGENTNET_URL:-http://127.0.0.1:${AGENTNET_PORT:-3096}/api/v1/agentnet}"
mod="${AGENTNET_MOD_DIR:-$(cd "$(dirname "$0")/../plugin" && pwd)}"
keyf="${AGENTNET_ROOT_TOKEN_FILE:-}"
# A corporate http_proxy/HTTPS_PROXY would send this loopback call to the proxy and it fails silently. Skip proxies for loopback.
case "$url" in http://127.0.0.1[:/]*|http://localhost[:/]*|http://\[::1\]*) np="--noproxy 127.0.0.1,localhost,::1" ;; *) np="" ;; esac
boss="${AGENTNET_BOSS:-root}"
case "$name" in ''|[!a-z0-9]*|*[!a-z0-9-]*) fail "bad name '$name'" ;; esac
[ -f "$mod/.claude-plugin/plugin.json" ] || fail "mod not found at $mod"
j() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
body="{\"name\":\"$(j "$name")\",\"job\":\"$(j "$job")\",\"boss\":\"$(j "$boss")\",\"kind\":\"member\",\"project\":\"$(j "$project")\"}"
if [ -n "$keyf" ] && [ -r "$keyf" ]; then
  resp="$(curl -s -m 5 $np -X POST "$url/spawn" -H "Authorization: Bearer $(cat "$keyf")" -H 'content-type: application/json' -d "$body" 2>/dev/null)"
else
  resp="$(curl -s -m 5 $np -X POST "$url/spawn" -H 'content-type: application/json' -d "$body" 2>/dev/null)"
fi
tf="$(printf '%s' "$resp" | sed -n 's/.*"token_file":"\([^"]*\)".*/\1/p')"
if [ -z "$tf" ]; then
  detail="$(printf '%s' "$resp" | sed -n 's/.*"detail":"\([^"]*\)".*/\1/p')"
  fail "spawn refused or no answer from $url: ${detail:-${resp:-no response (timeout or connection refused)}}"
fi
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
printf 'export AGENTNET_TOKEN_FILE=%s AGENTNET_AGENT=%s AGENTNET_JOB=%s AGENTNET_BOSS=%s AGENTNET_URL=%s AGENTNET_MOD=%s\n' \
  "$(q "$tf")" "$(q "$name")" "$(q "$job")" "$(q "$boss")" "$(q "$url")" "$(q "$mod")"
