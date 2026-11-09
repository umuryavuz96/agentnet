#!/usr/bin/env python3
"""agentnet usage guard (Claude Code PreToolUse).

Blocks heavy work when a Claude usage window (5-hour or weekly) is at or above a limit, so the last part of the
window stays free for chat and quick checks. Heavy work = spawning agents or workflows, any tool call made by a
sub-agent, and long builds, installs or training runs in Bash. Everything else passes.

Usage data (the fresher of the two, ignored when older than AGENTNET_USAGE_MAX_AGE_H hours):
  1. agentnet's usage file: $AGENTNET_USAGE_FILE or $AGENTNET_HOME/data/claude-usage.json
     ({"last": {"fetchedAt": <s>, "windows": [{"key": "five_hour"|"seven_day", "pct": <0-100>, "resetsAt": <s>}]}})
  2. a status line snapshot: $AGENTNET_USAGE_SNAPSHOT or ~/.claude/hooks/state/usage.json
     ({"ts": <s>, "windows": {"five_hour": {"used": <0-100>, "resets_at": <s>}}})
No data, stale data or any error: the call passes (fail open).

Env:
  AGENTNET_USAGE_LIMIT     percent at which heavy work stops, default 90
  AGENTNET_USAGE_MAX_AGE_H ignore older snapshots, default 3
  AGENTNET_USAGE_OVERRIDE  override file, default $AGENTNET_HOME/state/usage-override.
                           Touch it to let heavy work through for 2 hours.
  AGENTNET_USAGE_GUARD_LOG JSONL log, default $AGENTNET_HOME/logs/usage-guard.jsonl; "off" disables
"""
import json, os, re, sys, time

T0 = time.time()
HOME = os.path.expanduser(os.environ.get("AGENTNET_HOME") or "~/.local/share/agentnet")
HEAVY_TOOLS = {"Agent", "Task", "Workflow", "TeamCreate"}
HEAVY_BASH = re.compile(
    r"\b(xcodebuild|swift (build|test)|(bun|npm|pnpm|yarn) run build|npm (ci|install)|pnpm (build|install)"
    r"|docker (build|compose up)|cargo build|gradle|pip install|uv pip install|train|fine-?tune)\b",
    re.I,
)
NAMES = {"five_hour": "5-hour", "seven_day": "weekly"}


def num(x, d=None):
    try:
        return float(x)
    except (TypeError, ValueError):
        return d


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def snapshots():
    """[(ts, [(key, pct, resets_at)])] from both sources."""
    out = []
    a = load(os.environ.get("AGENTNET_USAGE_FILE") or os.path.join(HOME, "data", "claude-usage.json"))
    last = a.get("last") if isinstance(a, dict) else None
    if isinstance(last, dict) and isinstance(last.get("windows"), list):
        out.append((num(last.get("fetchedAt"), 0), [(w.get("key"), num(w.get("pct"), 0), num(w.get("resetsAt"))) for w in last["windows"] if isinstance(w, dict)]))
    s = load(os.environ.get("AGENTNET_USAGE_SNAPSHOT") or os.path.expanduser("~/.claude/hooks/state/usage.json"))
    if isinstance(s, dict) and isinstance(s.get("windows"), dict):
        out.append((num(s.get("ts"), 0), [(k, num(w.get("used"), 0), num(w.get("resets_at"))) for k, w in s["windows"].items() if isinstance(w, dict)]))
    return out


def log(rec):
    path = os.environ.get("AGENTNET_USAGE_GUARD_LOG") or os.path.join(HOME, "logs", "usage-guard.jsonl")
    if path == "off":
        return
    try:
        rec.update(ts=time.strftime("%Y-%m-%dT%H:%M:%S"), ms=int((time.time() - T0) * 1000))
        if os.environ.get("AGENTNET_AGENT"):
            rec["agent"] = os.environ["AGENTNET_AGENT"]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception:
        pass


def main():
    d = json.load(sys.stdin)
    tool = d.get("tool_name") or ""
    cmd = str((d.get("tool_input") or {}).get("command") or "") if tool == "Bash" else ""
    heavy = tool in HEAVY_TOOLS or bool(d.get("agent_id") or d.get("agent_type")) or bool(cmd and HEAVY_BASH.search(cmd))
    if not heavy:
        return 0
    now = time.time()
    ov = os.environ.get("AGENTNET_USAGE_OVERRIDE") or os.path.join(HOME, "state", "usage-override")
    try:
        if now - os.path.getmtime(ov) < 2 * 3600:
            return 0
    except OSError:
        pass
    limit = num(os.environ.get("AGENTNET_USAGE_LIMIT"), 90.0)
    max_age = num(os.environ.get("AGENTNET_USAGE_MAX_AGE_H"), 3.0) * 3600
    fresh = [s for s in snapshots() if s[0] and now - s[0] < max_age]
    if not fresh:
        return 0
    _, windows = max(fresh, key=lambda s: s[0])
    for key, pct, resets in windows:
        if key not in NAMES or (resets and resets < now) or pct < limit:
            continue
        when = f" It resets {time.strftime('%a %H:%M', time.localtime(resets))}." if resets else ""
        log({"reason": "blocked " + tool, "window": key, "used": round(pct)})
        print(f"Usage guard: the Claude {NAMES[key]} window is at {pct:.0f}% (limit {limit:.0f}%).{when} Heavy work "
              f"(agents, sub-agents, builds, training) is blocked; chat and light checks still work. Stop the heavy task and "
              f"tell the user. To allow it for 2 hours, the user can run: touch \"{ov}\"", file=sys.stderr)
        return 2
    return 0


try:
    code = main()
except BaseException:
    code = 0
sys.exit(code)
