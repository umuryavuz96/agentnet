#!/usr/bin/env python3
"""agentnet task guard (Claude Code PostToolUse).

Nudges an agentnet agent that does not keep its task list. Runs only in sessions with AGENTNET_AGENT set (agents
spawned by agentnet); every other session, and the director "root", is left alone. Adds one line of context when
the list is still empty after 5 tool calls, or when open tasks have had no update for 15 minutes while the agent
keeps working. At most one reminder per 10 minutes. Fail open: any problem prints nothing.

The agent's list is read from the agentnet service (AGENTNET_URL + the agent's AGENTNET_TOKEN_FILE, 1 s timeout);
when the service cannot be reached, only the task tools seen in this session count.

Env:
  AGENTNET_AGENT          set by agentnet for its agents; the hook does nothing without it
  AGENTNET_URL            default http://127.0.0.1:$AGENTNET_PORT/api/v1/agentnet (port 3096)
  AGENTNET_TOKEN_FILE     set by agentnet at spawn
  AGENTNET_TASK_GUARD_LOG JSONL log, default $AGENTNET_HOME/logs/task-guard.jsonl; "off" disables
State: $AGENTNET_HOME/state/task-guard/<session>.json
"""
import json, os, re, sys, time, urllib.request

T0 = time.time()
HOME = os.path.expanduser(os.environ.get("AGENTNET_HOME") or "~/.local/share/agentnet")
TASK_TOOLS = {"TodoWrite", "TaskCreate", "TaskUpdate"}
EMPTY_AFTER, STALE_SEC, GAP_SEC = 5, 900, 600


def service_tasks(agent):
    url = os.environ.get("AGENTNET_URL") or f"http://127.0.0.1:{os.environ.get('AGENTNET_PORT') or 3096}/api/v1/agentnet"
    with open(os.environ["AGENTNET_TOKEN_FILE"]) as f:
        tok = f.read().strip()
    req = urllib.request.Request(url + "/agents/" + agent, headers={"Authorization": "Bearer " + tok})
    with urllib.request.urlopen(req, timeout=1) as r:
        return (json.load(r).get("agent") or {}).get("tasks") or []


def log(rec):
    path = os.environ.get("AGENTNET_TASK_GUARD_LOG") or os.path.join(HOME, "logs", "task-guard.jsonl")
    if path == "off":
        return
    try:
        rec.update(ts=time.strftime("%Y-%m-%dT%H:%M:%S"), ms=int((time.time() - T0) * 1000))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception:
        pass


def main():
    agent = os.environ.get("AGENTNET_AGENT") or ""
    if not agent or agent == "root":
        return
    d = json.load(sys.stdin)
    sid = re.sub(r"[^A-Za-z0-9_-]", "", str(d.get("session_id") or ""))[:80]
    if not sid:
        return
    sdir = os.path.join(HOME, "state", "task-guard")
    os.makedirs(sdir, exist_ok=True)
    sp = os.path.join(sdir, sid + ".json")
    try:
        with open(sp) as f:
            st = json.load(f)
    except Exception:
        st = {"calls": 0, "last_update": T0, "last_remind": 0, "used_tool": False}
    st["calls"] += 1
    tool = d.get("tool_name") or ""
    if tool in TASK_TOOLS or tool.startswith("mcp__agentnet__task_"):
        st.update(used_tool=True, last_update=T0)
    tasks = []
    try:
        # agentnet's own task tools may not fire PostToolUse, so a change in the service's list counts as an update
        tasks = service_tasks(agent)
        sig = [[t.get("id"), t.get("status")] for t in tasks]
        if sig != st.get("sig"):
            st["sig"] = sig
            if tasks:
                st["last_update"] = T0
    except Exception:
        pass
    empty = not tasks and not st["used_tool"]
    has_open = any(t.get("status") != "done" for t in tasks) or st["used_tool"]
    why = "empty" if empty and st["calls"] >= EMPTY_AFTER else "stale" if has_open and T0 - st["last_update"] > STALE_SEC else None
    msg = None
    if why and T0 - st["last_remind"] > GAP_SEC:
        st["last_remind"] = T0
        msg = (f"[task-guard] Your task list is {'empty' if why == 'empty' else 'stale (no update for 15+ min)'}. "
               "Create one task per brief item and keep the status live with mcp__agentnet__task_add / task_start / "
               "task_done. Do it now, then continue.")
        log({"agent": agent, "reason": why, "calls": st["calls"]})
    tmp = sp + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, sp)
    if msg:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": msg}}))


try:
    main()
except BaseException:
    pass
sys.exit(0)
