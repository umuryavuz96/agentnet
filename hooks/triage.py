#!/usr/bin/env python3
"""agentnet triage hook (Claude Code UserPromptSubmit).

Reads the hook JSON on stdin, asks a small model to classify the prompt, and prints one
hookSpecificOutput JSON whose additionalContext is a single `[triage]` line. The director agent
reads that line and decides: do it inline, hand it to a background agent, or form a council team.

Fail-open: any problem (no claude, not logged in, timeout, bad JSON) prints nothing and exits 0.
Needs python3 and the `claude` CLI (Claude Code) logged in. No packages, no API key.
It runs `claude -p` with no settings sources, so no user hook loads and triage cannot trigger itself;
AGENTNET_TRIAGE_CHILD=1 is set for the child and makes this hook skip, as a second guard.

Env:
  AGENTNET_TRIAGE_MODEL    model alias or id passed to `claude -p --model`, default haiku
  AGENTNET_TRIAGE_BUDGET   total seconds, default 7
  AGENTNET_TRIAGE_STUB     JSON object: use it instead of calling claude (tests, dry runs)
  AGENTNET_TRIAGE_LOG      JSONL log path, default $AGENTNET_HOME/logs/triage.jsonl; "off" disables
  AGENTNET_BIN             agentnet executable for pick-model / pick-soul, default `agentnet`
  AGENTNET_RULES_HINT      path named in the RULE text, default docs/rules/council-teams.md

Self-test (no claude call): echo '{"prompt":"build a settings page"}' | triage.py --self-test
"""
import json, os, re, shutil, subprocess, sys, time

T0 = time.time()
BUDGET = float(os.environ.get("AGENTNET_TRIAGE_BUDGET", "7"))
MODEL = os.environ.get("AGENTNET_TRIAGE_MODEL", "haiku")
BIN = os.environ.get("AGENTNET_BIN", "agentnet")
HOME = os.path.expanduser(os.environ.get("AGENTNET_HOME") or "~/.local/share/agentnet")
RULES = os.environ.get("AGENTNET_RULES_HINT", "docs/rules/council-teams.md")

SELF_TEST_STUB = {"kind": "feature", "complexity": 4, "risk": 1, "expect": "normal", "explicit_model": "",
                  "route": "team", "role": "web-dev", "scope": 3, "novelty": 2,
                  "specialty": "ui settings forms", "council": "ux designer, accessibility, product critic",
                  "integrators": "web-dev", "reason": "self-test stub"}

SYSTEM = """You triage a message sent to a "director" agent. The director routes feature work to agent teams and handles chat, questions and tiny one-offs itself. Reply with ONE JSON object only, keys:
kind: chat|question|lookup|one-off|feature|ops|external
 chat=talk/ack/opinion; question=answerable from knowledge; lookup=read-only check/search; one-off=single small change, <=1 file, no build; feature=multi-file, UI, build, new capability, or anything needing visual verification; ops=server/service action; external=sends/publishes/buys (email, post, purchase).
complexity: 1-5
risk: 0-3 (0 none, 1 live UI/app, 2 live data/money/prod/security, 3 irreversible)
expect: low|normal|high (from wording: quick/cheap=low; proper job/important/quality=high)
explicit_model: haiku|sonnet|opus|fable if the user names a model, else ""
route: inline|background-agent|team (team=feature work; background-agent=small research/lookup worth delegating; inline=chat/question/tiny one-off/ops/external)
role: web-dev|backend|mobile-dev|designer|qa|researcher|ops|none
scope: 1-5 (files/systems touched), novelty: 1-3
specialty: 3-8 lowercase keywords naming the specialist skills the job needs, "" if route=inline.
council: ONLY if route=team: 3-5 short lowercase persona angles with DIFFERENT viewpoints that would debate this job (e.g. "api designer, security, ops"); else "".
integrators: ONLY if route=team: 1-2 roles that write code and build (from web-dev|backend|mobile-dev), comma-separated; else "".
reason: max 15 words.
Short replies like "send it"/"yes" that confirm a prior action: kind=external or chat as fits, route=inline. If unsure between inline and team for build work, choose team."""

ROLE_MAP = {"ops": "devops", "none": "lookup"}


def left(cap):
    return max(0.3, min(cap, BUDGET - (time.time() - T0) - 0.1))


def log(rec):
    path = os.environ.get("AGENTNET_TRIAGE_LOG") or os.path.join(HOME, "logs", "triage.jsonl")
    if path == "off":
        return
    try:
        rec["ts"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        rec["ms"] = int((time.time() - T0) * 1000)
        if os.environ.get("AGENTNET_AGENT"):
            rec["agent"] = os.environ["AGENTNET_AGENT"]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception:
        pass


def skip(p):
    """Prompts that need no triage: empty, slash commands, system notices, bare acks."""
    if not p or p.startswith("/"):
        return True
    if p.startswith(("<system-reminder>", "<task-notification>")) or "[SYSTEM NOTIFICATION" in p:
        return True
    ack = r"(ok(ay)?|yes|yep|yeah|no|nope|thanks?|thx|ty|k|sure|cool|nice|good|great|done)[.!\s]*"
    return len(p.split()) < 3 and re.fullmatch(ack, p, re.I) is not None


class Skip(Exception):
    """Triage cannot run; .reason goes to the log as {skip: true, reason}."""
    def __init__(self, reason):
        self.reason = reason


def classify(p, deadline):
    """Return the classifier JSON or None. Stub env wins; else one `claude -p` call (prompt on stdin)."""
    stub = os.environ.get("AGENTNET_TRIAGE_STUB")
    if stub:
        return json.loads(stub)
    exe = shutil.which("claude")
    if not exe:
        raise Skip("no_claude")
    cmd = [exe, "-p", "--model", MODEL, "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands",
           "--output-format", "text", "--system-prompt", SYSTEM]
    try:
        r = subprocess.run(cmd, input=p[:2000], capture_output=True, text=True, timeout=deadline,
                           env={**os.environ, "AGENTNET_TRIAGE_CHILD": "1"})
    except subprocess.TimeoutExpired:
        raise Skip("timeout")
    text = (r.stdout or "") + (r.stderr or "")
    if "Not logged in" in text:
        raise Skip("not_logged_in")
    m = re.search(r"\{.*\}", r.stdout or "", re.S)
    return json.loads(m.group(0)) if m else None


def run_first_line(cmd, cap):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=left(cap))
    out = r.stdout.strip().splitlines()
    return (out[0] if out else ""), r.returncode


def build_context(p, j):
    """Classifier JSON -> the [triage] line. Calls pick-model / pick-soul for team and agent routes."""
    kind, route, role = j.get("kind", "?"), j.get("route", "inline"), j.get("role", "none")
    line = ""
    if route in ("team", "background-agent"):
        def n(k, lo, hi, dflt):
            try:
                return str(min(hi, max(lo, int(j.get(k, dflt)))))
            except Exception:
                return str(dflt)
        r = ROLE_MAP.get(role, role)
        try:
            cmd = [BIN, "pick-model", "--role", r, "--scope", n("scope", 1, 5, 3), "--novelty", n("novelty", 1, 3, 2),
                   "--risk", n("risk", 0, 3, 0), "--no-log"]
            if j.get("expect") in ("low", "normal", "high"):
                cmd += ["--expect", j["expect"]]
            if j.get("explicit_model") in ("haiku", "sonnet", "opus", "fable"):
                cmd += ["--explicit", j["explicit_model"]]
            first, rc = run_first_line(cmd, 2)
            line = first or f"pick-model exit {rc}"
        except Exception:
            line = "pick-model unavailable"
        try:
            first, rc = run_first_line([BIN, "pick-soul", "--role", r, "--ask", p[:300],
                                        "--need", str(j.get("specialty", ""))[:120], "--no-log"], 1)
            m = re.match(r"soul=(\S+)", first) if rc == 0 else None
            if m:
                line += f" soul={m.group(1)}"
                ma = re.search(r"alts=(\S+)", first)
                if ma:
                    line += f" soul_alts={ma.group(1)}"
        except Exception:
            pass
    cl = lambda v: ",".join(re.sub(r"[^a-z0-9 -]", "", x.lower()).strip().replace(" ", "-")
                            for x in (v if isinstance(v, list) else str(v or "").split(",")) if str(x).strip())
    council = cl(j.get("council")) if route == "team" else ""
    integ = cl(j.get("integrators")) if route == "team" else ""
    if council:
        line += f" council={council}" + (f" integrators={integ}" if integ else "")
    reason = re.sub(r"\s+", " ", str(j.get("reason", "")))[:120]
    return (f"[triage] kind={kind} complexity={j.get('complexity', '?')} risk={j.get('risk', '?')} route={route} role={role}"
            + (f" -> {line}" if line else "")
            + f" | reason: {reason} | RULE: route=team means form a council team per {RULES} "
              "(do not implement inline; run `agentnet council`, pass soul=<id> to --soul and model to --model); "
              "external means ask the user before sending, publishing or buying")


def main():
    self_test = "--self-test" in sys.argv
    if os.environ.get("AGENTNET_TRIAGE_CHILD"):
        return  # we are inside our own claude -p call: never recurse
    try:
        d = json.load(sys.stdin)
    except Exception:
        return
    p = re.sub(r"</?channel[^>]*>", "", (d.get("prompt") or "")).strip()
    if skip(p):
        return
    try:
        j = SELF_TEST_STUB if self_test else classify(p, left(BUDGET - 0.4))
    except Skip as e:
        log({"skip": True, "reason": e.reason})  # nothing to classify with: no error line; the log record lets the Agents page say why
        return
    except Exception:
        j = None
    if not isinstance(j, dict) or "kind" not in j or "route" not in j:
        log({"p": p[:60], "err": "no-result"})
        return
    ctx = build_context(p, j)
    log({"p": p[:60], "kind": j.get("kind"), "route": j.get("route"), "specialty": j.get("specialty", "")})
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": ctx}}))
    sys.stdout.flush()


try:
    main()
except BaseException:
    pass
sys.stdout.flush()
os._exit(0)
