#!/usr/bin/env python3
"""agentnet skill router (Claude Code UserPromptSubmit).

Scores each prompt against your own rules and, for the best matches, adds one line that tells Claude to use a
skill, start an agent or read a file first. Plain instructions that name the skill work better than hints.

Rules: $AGENTNET_SKILL_RULES or $AGENTNET_HOME/config/skill-rules.json. When the file is missing, the first run writes
it with no rules and one example under "$example", and the hook does nothing until you add rules. Rule shape:
  {"id": "pdf", "type": "skill"|"agent"|"reference", "keywords": ["pdf"], "patterns": ["\\\\.pdf\\\\b"],
   "pathHints": ["/docs"], "file": "docs/guide.md"}
Scoring: keyword 2, regex 3, a pathHint in the working directory 5 (a boost only). Threshold 2, at most 2 picks, and
the same rule is not repeated in one session within 4 hours. Prompts shorter than 8 characters and slash commands
are skipped. Fail open: any problem prints nothing.

State: $AGENTNET_HOME/state/skill-router.json
"""
import json, os, re, sys, time

HOME = os.path.expanduser(os.environ.get("AGENTNET_HOME") or "~/.local/share/agentnet")
THRESHOLD, MAX_PICKS, REPEAT_S, KEEP_S = 2, 2, 4 * 3600, 24 * 3600
SEED = {
    "$comment": "agentnet skill router rules. keyword=2, regex pattern=3, pathHint in the working directory=5. "
                "type: skill (Skill tool), agent (Agent tool), reference (read `file`). Add rules to the rules list.",
    "$example": {"id": "pdf", "type": "skill", "keywords": ["pdf", "merge pdfs"], "patterns": ["\\.pdf\\b"], "pathHints": []},
    "rules": [],
}


def rules_file():
    return os.environ.get("AGENTNET_SKILL_RULES") or os.path.join(HOME, "config", "skill-rules.json")


def load_rules():
    f = rules_file()
    if not os.path.exists(f):
        try:
            os.makedirs(os.path.dirname(f), exist_ok=True)
            with open(f, "x") as out:
                json.dump(SEED, out, indent=2)
        except Exception:
            pass
        return []
    with open(f) as fh:
        r = json.load(fh).get("rules")
    return [x for x in r if isinstance(x, dict) and isinstance(x.get("id"), str)] if isinstance(r, list) else []


def score(rule, prompt, lower, cwd):
    s, hits = 0, []
    for k in rule.get("keywords") or []:
        if isinstance(k, str) and k and k.lower() in lower:
            s += 2; hits.append(k)
    for p in rule.get("patterns") or []:
        try:
            if re.search(p, prompt, re.I):
                s += 3; hits.append("/" + p + "/")
        except Exception:
            pass
    for h in rule.get("pathHints") or []:
        if isinstance(h, str) and h and h in cwd:
            s += 5
    return s, hits


def line(rule, hits):
    why = "(matched: " + ", ".join(str(h) for h in hits[:3]) + ")"
    t, rid = rule.get("type", "skill"), rule["id"]
    if t == "agent":
        return f'- This matches the "{rid}" agent: start it with the Agent tool {why} unless the task is trivial.'
    if t == "reference":
        return f"- Read {rule.get('file') or rid} before acting {why}."
    return f'- Use the Skill tool with skill "{rid}" BEFORE other work {why}. If it is clearly not relevant, skip it.'


def main():
    d = json.load(sys.stdin)
    prompt = str(d.get("prompt") or "")
    if len(prompt) < 8 or prompt.startswith("/"):
        return
    rules = load_rules()
    if not rules:
        return
    lower, cwd, sid = " " + prompt.lower() + " ", str(d.get("cwd") or ""), str(d.get("session_id") or "global")
    scored = []
    for r in rules:
        s, hits = score(r, prompt, lower, cwd)
        if s >= THRESHOLD and hits:
            scored.append((s, r, hits))
    if not scored:
        return
    scored.sort(key=lambda x: -x[0])
    sf = os.path.join(HOME, "state", "skill-router.json")
    try:
        with open(sf) as f:
            seen = json.load(f)
    except Exception:
        seen = {}
    now = time.time()
    seen = {k: v for k, v in seen.items() if isinstance(v, dict) and v and now - max(v.values()) < KEEP_S}
    mine = seen.setdefault(sid, {})
    picked = []
    for _, r, hits in scored:
        if len(picked) >= MAX_PICKS:
            break
        if now - mine.get(r["id"], 0) < REPEAT_S:
            continue
        picked.append(line(r, hits)); mine[r["id"]] = now
    if not picked:
        return
    try:
        os.makedirs(os.path.dirname(sf), exist_ok=True)
        with open(sf + ".tmp", "w") as f:
            json.dump(seen, f)
        os.replace(sf + ".tmp", sf)
    except Exception:
        pass
    ctx = "[skill-router] Routing for this request:\n" + "\n".join(picked)
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": ctx}}))


try:
    main()
except BaseException:
    pass
sys.exit(0)
