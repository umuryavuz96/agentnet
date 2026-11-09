#!/usr/bin/env bash
# pick-model.sh: deterministic model + effort picker for agent spawns.
# Standard: docs/model-routing.md. Tunables: $AGENTNET_HOME/config/model-routing.json
# (missing/invalid -> built-in defaults + warning).
# Usage: pick-model.sh --role <web-dev-1|backend|qa|...> --scope 1-5 --novelty 1-3 --risk 0-3
#          [--expect low|normal|high] [--ask "<the owner's words>"] [--explicit haiku|sonnet|opus|fable]
#          [--usage <pct>] [--job "<text>"] [--no-log]
#        pick-model.sh --write-default-config     (writes the defaults file if it does not exist)
# Prints: mode=<m> model=<alias> effort=<level> score=<n> usage=<pct> reason=<short>   (warnings on stderr)
# Exit: 0 ok, 1 bad input, 2 blocked (reserve mode, no override file).
exec /usr/bin/env python3 - "$@" <<'PY'
import argparse, copy, json, os, re, sys, time, datetime

H = os.path.expanduser
AGH = H(os.environ.get("AGENTNET_HOME") or "~/.local/share/agentnet")
CFG = H(os.environ.get("MODEL_ROUTING_FILE") or os.path.join(AGH, "config", "model-routing.json"))
OVERRIDE = H(os.environ.get("AGENTNET_USAGE_OVERRIDE") or "")  # off unless set; a file younger than 2 h lifts the reserve block
MODELS = ["haiku", "sonnet", "opus", "fable"]
EFFORTS = ["low", "medium", "high", "xhigh", "max"]

def f(value, description, **kw): return {"value": value, "description": description, **kw}
def role(points, writes, light, d): return {"points": points, "writes": writes, "light": light, "description": d}

DEFAULTS = {
  "version": 1,
  "description": "Agent model routing. Read by agentnet pick-model; rules in docs/model-routing.md.",
  "points": {
    "scope_step":   f(1, "Points per scope step above 1 (scope 1 = one file, 5 = many systems)", type="int", min=0, max=5),
    "novelty_step": f(2, "Points per novelty step above 1 (1 = done before, 3 = new ground/ambiguous)", type="int", min=0, max=5),
    "risk_step":    f(2, "Points per risk level (0 none, 1 live UI, 2 live data/money/security, 3 irreversible)", type="int", min=0, max=5),
  },
  "expect": {
    "low":    f(-2, "Points when the owner signals quick/cheap", type="int", min=-5, max=5),
    "normal": f(0,  "Points with no signal", type="int", min=-5, max=5),
    "high":   f(3,  "Points when the owner signals quality/importance", type="int", min=-5, max=5),
  },
  "expect_keywords": {
    "high": f(["proper job", "properly", "important", "amazing", "quality", "perfect", "polish", "best", "critical", "carefully"],
              "Words in the owner's ask (--ask) that set expect=high", type="string[]"),
    "low":  f(["quick", "quickly", "cheap", "just", "rough", "draft", "simple", "small", "fast"],
              "Words in the owner's ask that set expect=low (high wins if both match)", type="string[]"),
  },
  "roles": {
    "lookup":     role(-3, False, True,  "Greps, file finds, data pulls"),
    "doc":        role(-2, False, True,  "Docs, notes, reformatting"),
    "qa":         role(-2, False, True,  "Screenshots, test runs, checks against a spec"),
    "researcher": role(-1, False, True,  "Web/market research, comparisons"),
    "reviewer":   role(0,  False, False, "Code/design review"),
    "web-dev":    role(0,  True,  False, "Web UI and front-end"),
    "backend":    role(0,  True,  False, "Servers, APIs, daemons, scripts"),
    "devops":     role(0,  True,  False, "Infra, launchd, Caddy, Docker"),
    "mobile-dev": role(1,  True,  False, "iOS/Android apps (build cycles are slow, mistakes are costly)"),
    "designer":   role(1,  True,  False, "Visual/UX design, motion"),
    "architect":  role(2,  True,  False, "System design, multi-system plans"),
  },
  "bands": f([
      {"max_score": 1,    "model": "haiku",  "effort": "low"},
      {"max_score": 3,    "model": "sonnet", "effort": "medium"},
      {"max_score": 6,    "model": "sonnet", "effort": "high"},
      {"max_score": 9,    "model": "opus",   "effort": "medium"},
      {"max_score": 12,   "model": "opus",   "effort": "high"},
      {"max_score": None, "model": "fable",  "effort": "high"}],
    "Score bands, ascending; first band with score <= max_score wins; last band max_score null = no limit",
    type="band[]"),
  "floors": {
    "risk_sonnet_high": f(2, "Risk at or above this -> at least sonnet/high (not in eco)", type="int", min=0, max=3),
    "risk_opus":        f(3, "Risk at or above this -> at least opus (eco caps it and warns)", type="int", min=0, max=3),
  },
  "usage": {
    "window":      f("max", "Which window drives the mode", type="enum", options=["max", "five_hour", "seven_day"]),
    "stale_hours": f(3, "Ignore usage snapshots older than this (mode falls back to normal)", type="int", min=1, max=24),
    "pace": {
      "enabled":       f(True, "Escalate one mode when the window is burning faster than it refills", type="bool"),
      "projected_pct": f(110, "Escalate when used% / elapsed-fraction projects at or above this by reset", type="int", min=100, max=300),
      "min_elapsed":   f(0.25, "Only judge pace after this fraction of the window has passed", type="float", min=0.05, max=0.9),
    },
    "modes": {
      "careful": {
        "min_pct":        f(60, "Usage % where careful mode starts", type="int", min=1, max=89),
        "effort_drop":    f(1, "Effort levels to drop (never below the risk floor)", type="int", min=0, max=2),
        "opus_min_score": f(10, "Opus only at or above this score (else sonnet/high)", type="int", min=0, max=30),
        "allow_fable":    f(False, "Allow Fable without an explicit ask", type="bool"),
      },
      "eco": {
        "min_pct":             f(80, "Usage % where eco mode starts", type="int", min=1, max=89),
        "builder_max_model":   f("sonnet", "Highest model for writing roles", type="enum", options=MODELS),
        "light_model":         f("haiku", "Model for light roles (qa/research/lookup/doc)", type="enum", options=MODELS),
        "max_effort":          f("medium", "Highest effort", type="enum", options=EFFORTS),
        "max_active_teams":    f(1, "Job teams allowed at once", type="int", min=1, max=5),
        "max_agents_per_team": f(3, "Agents per team", type="int", min=1, max=10),
      },
      "reserve": {
        "min_pct": f(90, "Usage % where heavy work stops (the owner's hard rule; cannot be set below 90)", type="int", min=90, max=100),
      },
    },
  },
}

def V(x): return x["value"] if isinstance(x, dict) and "value" in x else x

def merge(base, over):
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict) and "value" not in base[k]: merge(base[k], v)
        elif isinstance(base.get(k), dict) and "value" in base[k]: base[k]["value"] = V(v)
        else: base[k] = v
    return base

def validate(c):
    for b in V(c["bands"]):
        assert b["model"] in MODELS and b["effort"] in EFFORTS
    m = [b["max_score"] for b in V(c["bands"])]
    assert m[-1] is None and all(isinstance(x, int) for x in m[:-1]) and m[:-1] == sorted(m[:-1])
    mo = c["usage"]["modes"]
    assert V(mo["careful"]["min_pct"]) < V(mo["eco"]["min_pct"]) <= V(mo["reserve"]["min_pct"])
    for r in c["roles"].values(): assert isinstance(r["points"], int)

warns = []
def load_cfg():
    c = copy.deepcopy(DEFAULTS)
    if not os.path.exists(CFG): return c  # built-in defaults, no noise on a fresh install
    try:
        c = merge(c, json.load(open(CFG))); validate(c)
    except Exception as e:
        warns.append(f"WARNING: {CFG} invalid ({e!r}), using built-in defaults"); return copy.deepcopy(DEFAULTS)
    r = c["usage"]["modes"]["reserve"]["min_pct"]
    if V(r) < 90: warns.append("WARNING: reserve.min_pct < 90 not allowed, using 90"); r["value"] = 90
    return c

def live_windows(cfg):
    """{key: (pct, resets_at, hours)} from the file in AGENTNET_USAGE_FILE. Off (empty) when the variable is unset."""
    f = os.environ.get("AGENTNET_USAGE_FILE")
    if not f: return {}, "none"
    now = time.time()
    hours = lambda k: 5 if k.startswith("five_hour") else 168
    try:
        l = json.load(open(H(f)))["last"]
        if now - l["fetchedAt"] >= V(cfg["usage"]["stale_hours"]) * 3600: return {}, "none(stale)"
        ws = {w["key"]: (w["pct"], w.get("resetsAt"), w.get("hours") or hours(w["key"])) for w in l.get("windows", [])}
    except Exception: return {}, "none(unreadable)"
    ws = {k: v for k, v in ws.items() if k in ("five_hour", "seven_day") and not (v[1] and float(v[1]) < now)}
    return ws, "file"

p = argparse.ArgumentParser(prog="pick-model.sh")
p.add_argument("--write-default-config", action="store_true")
p.add_argument("--role"); p.add_argument("--scope", type=int, choices=range(1, 6))
p.add_argument("--novelty", type=int, choices=range(1, 4)); p.add_argument("--risk", type=int, choices=range(0, 4))
p.add_argument("--expect", choices=["low", "normal", "high"]); p.add_argument("--ask", default="")
p.add_argument("--explicit", choices=MODELS); p.add_argument("--usage", type=float)
p.add_argument("--job", default=""); p.add_argument("--no-log", action="store_true")
try: a = p.parse_args(sys.argv[1:])
except SystemExit as e: sys.exit(1 if e.code else 0)

if a.write_default_config:
    if os.path.exists(CFG): print(f"exists: {CFG}"); sys.exit(0)
    os.makedirs(os.path.dirname(CFG), exist_ok=True)
    json.dump(DEFAULTS, open(CFG, "w"), indent=2); print(f"wrote {CFG}"); sys.exit(0)
if None in (a.role, a.scope, a.novelty, a.risk):
    print("need --role --scope --novelty --risk", file=sys.stderr); sys.exit(1)

cfg = load_cfg()
ROLES, MO = cfg["roles"], cfg["usage"]["modes"]
rname = re.sub(r"-\d+$", "", a.role.lower())
if rname not in ROLES:
    print(f"unknown role '{rname}', known: {', '.join(sorted(ROLES))}", file=sys.stderr); sys.exit(1)
R = ROLES[rname]

# expectation + explicit model from the owner's words (flags win over --ask)
ask = a.ask.lower()
has = lambda words: any(re.search(r"\b" + re.escape(w) + r"\b", ask) for w in words)
expect = a.expect or ("high" if has(V(cfg["expect_keywords"]["high"])) else "low" if has(V(cfg["expect_keywords"]["low"])) else "normal")
explicit = a.explicit or next((m for m in MODELS if re.search(r"\b" + m + r"\b", ask)), None)

# usage -> mode
pace_note = ""
if a.usage is not None: usage, usrc, ws = a.usage, "flag", {}
else:
    ws, usrc = live_windows(cfg)
    pick = V(cfg["usage"]["window"])
    sel = ws if pick == "max" else {k: v for k, v in ws.items() if k == pick}
    usage = max((v[0] for v in sel.values()), default=0.0)
order = ["normal", "careful", "eco", "reserve"]
mode = ("reserve" if usage >= V(MO["reserve"]["min_pct"]) else "eco" if usage >= V(MO["eco"]["min_pct"])
        else "careful" if usage >= V(MO["careful"]["min_pct"]) else "normal")
pc = cfg["usage"]["pace"]
if V(pc["enabled"]) and mode in ("normal", "careful", "eco") and a.usage is None:
    for k, (pct, resets, hrs) in ws.items():
        if not resets: continue
        elapsed = 1 - (float(resets) - time.time()) / (hrs * 3600)
        if elapsed >= V(pc["min_elapsed"]) and pct / elapsed >= V(pc["projected_pct"]):
            new = order[min(order.index(mode) + 1, 2)]  # pace never triggers reserve
            if new != mode: pace_note = f"pace:{k} {pct:g}% at {elapsed:.0%} of window -> {pct/elapsed:.0f}% projected"; mode = new
            break
override = bool(os.environ.get("AGENTNET_USAGE_OVERRIDE")) and os.path.exists(OVERRIDE) and time.time() - os.path.getmtime(OVERRIDE) < 7200
eco = mode == "eco" or (mode == "reserve" and override)

P = cfg["points"]
score = ((a.scope - 1) * V(P["scope_step"]) + (a.novelty - 1) * V(P["novelty_step"]) + a.risk * V(P["risk_step"])
         + R["points"] + V(cfg["expect"][expect]))
band = next(b for b in V(cfg["bands"]) if b["max_score"] is None or score <= b["max_score"])
model, effort = band["model"], band["effort"]
notes = [f"scope{a.scope} nov{a.novelty} risk{a.risk} {rname}{R['points']:+d} expect:{expect}"]
if pace_note: notes.append(pace_note)
lower = lambda e, n: EFFORTS[max(0, EFFORTS.index(e) - n)]
idx = MODELS.index
F = cfg["floors"]

if mode == "careful":
    C = MO["careful"]
    if model == "fable" and not V(C["allow_fable"]): model = "opus"; notes.append("careful:fable->opus")
    if model == "opus" and score < V(C["opus_min_score"]): model, effort = "sonnet", "high"; notes.append("careful:opus->sonnet")
    if V(C["effort_drop"]): effort = lower(effort, V(C["effort_drop"])); notes.append(f"careful:-{V(C['effort_drop'])} effort")
elif eco:
    E = MO["eco"]
    cap = V(E["light_model"]) if R["light"] else V(E["builder_max_model"])
    if R["light"] or idx(model) > idx(cap): model = cap
    if EFFORTS.index(effort) > EFFORTS.index(V(E["max_effort"])): effort = V(E["max_effort"])
    notes.append(f"eco:cap {cap}/{V(E['max_effort'])}")
# safety floors: writers never on haiku; risky work keeps sonnet/high; irreversible work wants opus
if R["writes"] and model == "haiku": model = "sonnet"; notes.append("floor:writer>=sonnet")
if a.risk >= V(F["risk_sonnet_high"]):
    if model == "haiku": model = "sonnet"; notes.append("floor:risk>=sonnet")
    if model == "sonnet" and not eco and EFFORTS.index(effort) < 2: effort = "high"; notes.append("floor:risk>=high")
if a.risk >= V(F["risk_opus"]) and idx(model) < idx("opus"):
    if eco: warns.append("WARNING: risk-3 job in eco mode capped below opus; defer it or get the owner's explicit ok")
    else: model, effort = "opus", ("medium" if EFFORTS.index(effort) < 1 else effort); notes.append("floor:risk3>=opus")

if explicit:
    if explicit != model:
        effort = "high" if expect == "high" or score >= V(MO["careful"]["opus_min_score"]) else "medium"
        if eco and EFFORTS.index(effort) > EFFORTS.index(V(MO["eco"]["max_effort"])): effort = V(MO["eco"]["max_effort"])
    model = explicit; notes.append(f"explicit:{explicit} (the owner wins)")
    if eco: warns.append(f"WARNING: eco mode (usage {usage:g}%) but the owner named {explicit}; honoring it, mention the usage in the spawn report")

status, code = "ok", 0
if mode == "reserve":
    if override: notes.append("reserve:override active, eco rules")
    else:
        status, code = "blocked", 2
        warns.append(f"BLOCKED: reserve mode (usage {usage:g}% >= {V(MO['reserve']['min_pct'])}). No new heavy work; "
                     f"chat/light checks only. set AGENTNET_USAGE_OVERRIDE to a file path and touch it to lift this for 2 h")
if eco:
    E = MO["eco"]
    warns.append(f"eco: max {V(E['max_active_teams'])} active job team(s), max {V(E['max_agents_per_team'])} agents per team, "
                 "reuse an existing agent before spawning, in-process subagents only for tiny lookups; "
                 "for checkable work run low first and re-run only failures higher")

reason = "; ".join(notes)
print(f"mode={mode} model={model} effort={effort} score={score} usage={usage:g} reason={reason}")
for w in warns: print(w, file=sys.stderr)
if not a.no_log:
    log = H(os.environ.get("MODEL_ROUTING_LOG") or os.path.join(AGH, "logs", "model-routing.jsonl")); os.makedirs(os.path.dirname(log), exist_ok=True)
    with open(log, "a") as fh:
        fh.write(json.dumps({"ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            "agent": a.role, "job": a.job, "mode": mode, "usage": usage, "usage_src": usrc,
            "inputs": {"role": rname, "scope": a.scope, "novelty": a.novelty, "risk": a.risk, "expect": expect,
                       "explicit": explicit, "ask": a.ask},
            "model": model, "effort": effort, "score": score, "status": status,
            "reason": reason, "warnings": warns}) + "\n")
sys.exit(code)
PY
