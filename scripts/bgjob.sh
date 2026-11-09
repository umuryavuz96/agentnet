#!/usr/bin/env bash
# Start a long job detached AND make it visible in agentnet (agent network temp card under its owner; owner defaults to $AGENTNET_AGENT).
# Usage: bgjob.sh [--owner agent-name] [--log FILE] [--outputs DIR]... [--progress FILE.json] [--total N] '<description>' -- <command...>
#   --outputs: folder(s) the job writes files to (watched + previewed in agentnet); --progress: JSON file {"done":n,"total":n,"label":"..."} the job updates; --total: expected number of output files.
# Card: $AGENTNET_BGJOBS/<id>.json (default $AGENTNET_HOME/bgjobs); exit code goes to <id>.exit when it ends.
set -u
OWNER="${AGENTNET_AGENT:-${AGMSG_OWNER:-}}"; LOG=""; OUTS=""; PROG=""; TOTAL=""
while [ $# -gt 0 ]; do case "$1" in --owner) OWNER="$2"; shift 2;; --log) LOG="$2"; shift 2;; --outputs) OUTS="$OUTS${OUTS:+:}$2"; shift 2;; --progress) PROG="$2"; shift 2;; --total) TOTAL="$2"; shift 2;; *) break;; esac; done
DESC="${1:?usage: bgjob.sh [--owner team/name] [--log FILE] '<description>' -- <command...>}"; shift
[ "${1:-}" = "--" ] && shift
[ $# -gt 0 ] || { echo "no command" >&2; exit 2; }
DIR="${AGENTNET_BGJOBS:-${AGENTNET_HOME:-$HOME/.local/share/agentnet}/bgjobs}"; mkdir -p "$DIR"
ID="$(date +%s)-$$"; LOG="${LOG:-$DIR/$ID.log}"
CMD="$(printf '%q ' "$@")"
nohup bash -c "$CMD; echo \$? > '$DIR/$ID.exit'" >"$LOG" 2>&1 < /dev/null &
PID=$!
python3 - "$DIR/$ID.json" "$ID" "$OWNER" "${CLAUDE_CODE_SESSION_ID:-}" "$PID" "$DESC" "$LOG" "$(pwd)" "$OUTS" "$PROG" "$TOTAL" <<'PY'
import json, os, sys, time
p, i, owner, sess, pid, desc, log, cwd, outs, prog, total = sys.argv[1:12]
ab = lambda x: os.path.abspath(os.path.expanduser(x))
card = {"id": i, "owner": owner or None, "session": sess or None, "pid": int(pid), "desc": desc[:200], "log": log, "cwd": cwd, "started": int(time.time() * 1000)}
if outs: card["outputs"] = [ab(x) for x in outs.split(":") if x]
if prog: card["progress"] = {"file": ab(prog)}
if total.isdigit(): card["total"] = int(total)
json.dump(card, open(p, "w"))
PY
echo "bgjob $ID pid=$PID log=$LOG"
