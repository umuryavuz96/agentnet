#!/usr/bin/env python3
"""agentnet context size warning (Claude Code Stop).

After each turn, reads how big the conversation's context is (input + cache read + cache write tokens of the last
model call in the transcript). Above the threshold it shows you a short note, so you can run /compact at a natural
break. The end of a turn is that break. At most one note per session every 20 minutes. Fail open.

Env:
  AGENTNET_CONTEXT_WARN_AT  token threshold, default 150000
State: $AGENTNET_HOME/state/context-warning/<session>
"""
import json, os, re, sys, time

HOME = os.path.expanduser(os.environ.get("AGENTNET_HOME") or "~/.local/share/agentnet")
GAP_S = 1200


def context_tokens(path):
    """Usage of the last model call, from the last ~256 KB of the transcript."""
    with open(path, "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - 262144))
        tail = f.read().decode("utf8", "replace").splitlines()
    last = 0
    for l in tail:
        try:
            m = json.loads(l).get("message")
        except Exception:
            continue
        u = m.get("usage") if isinstance(m, dict) else None
        if isinstance(u, dict):
            last = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
    return last


def main():
    d = json.load(sys.stdin)
    t, sid = d.get("transcript_path") or "", re.sub(r"[^A-Za-z0-9_-]", "", str(d.get("session_id") or ""))[:80]
    if not t or not os.path.isfile(t):
        return
    try:
        limit = int(os.environ.get("AGENTNET_CONTEXT_WARN_AT") or 150000)
    except ValueError:
        limit = 150000
    n = context_tokens(t)
    if n < limit:
        return
    if sid:
        stamp = os.path.join(HOME, "state", "context-warning", sid)
        try:
            if time.time() - os.path.getmtime(stamp) < GAP_S:
                return
        except OSError:
            pass
        try:
            os.makedirs(os.path.dirname(stamp), exist_ok=True)
            with open(stamp, "w") as f:
                f.write(str(int(time.time())))
        except Exception:
            pass
    print(json.dumps({"systemMessage": f"Context is at {n // 1000}k tokens (warning at {limit // 1000}k). Consider /compact at a natural break."}))


try:
    main()
except BaseException:
    pass
sys.exit(0)
