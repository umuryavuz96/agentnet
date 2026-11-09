#!/usr/bin/env bash
# pick-soul.sh: deterministic persona ("soul") picker for agent spawns. Sibling of pick-model.sh.
# Catalog: <repo>/arsenal/catalog.json (override: ARSENAL_DIR). Role defaults (editable in the Arsenal page): roles.json beside it
# Usage: pick-soul.sh --role <web-dev|backend|qa|...> [--ask "<text>"] [--agent <name>] [--job "<text>"] [--no-log]
# Prints: soul=<catalog-id> role=<r> score=<n> kw=<n> reason=<short>   (nothing + exit 1 if no catalog/role)
# Since 2026-11-03 (the owner: "if we keep roles to defaults then we dont benefit from catalog"): candidates = WHOLE catalog.
# Score = keyword hits (name x3, tags x2, description x1) from --ask, x2 for --need (specialty words from triage),
#   + 3 for the role default, + 1 for agents in the role's categories (alternates count as in-category). Ties -> default, then id.
# Also prints alts=<id>,<id> (next best two) so the director can pick by hand.
ARSENAL_DIR="${ARSENAL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/arsenal}" exec /usr/bin/env python3 - "$@" <<'PY'
import argparse, json, os, re, sys, time
H = os.path.expanduser
ARS = H(os.environ["ARSENAL_DIR"])
AGH = H(os.environ.get("AGENTNET_HOME") or "~/.local/share/agentnet")
LOG = H(os.environ.get("SOUL_LOG") or os.path.join(AGH, "logs", "soul-routing.jsonl"))
ap = argparse.ArgumentParser()
ap.add_argument("--role"); ap.add_argument("--ask", default=""); ap.add_argument("--agent", default="")
ap.add_argument("--job", default=""); ap.add_argument("--need", default=""); ap.add_argument("--no-log", action="store_true")
a = ap.parse_args()
def load(p):
    try: return json.load(open(p))
    except Exception: return None
cat, roles = load(f"{ARS}/catalog.json"), load(f"{ARS}/roles.json")
if not cat or not roles or not a.role: sys.exit(1)
agents = {x["id"]: x for x in cat.get("agents", []) if (x.get("review") or {}).get("status", "clean") != "dropped"}
role = (a.role or "").lower(); role = re.sub(r"-\d+$", "", role)
r = (roles.get("roles") or {}).get(role)
if not r: sys.exit(1)
STOP = set("a an the and or to of for in on with is it this that please make build add fix new want need use using can you i we my our".split())
def toks(t):
    out = []
    for w in re.findall(r"[a-z0-9+#]{3,}", t.lower()):
        if w in STOP: continue
        for suf in ("ing", "ers", "er", "es", "s"):
            if len(w) > 5 and w.endswith(suf): w = w[: -len(suf)]; break
        out.append(w)
    return set(out)
words = toks(a.ask + " " + a.job); need = toks(a.need)
default = r.get("default")
alts = set(r.get("alternates") or [])
cats = set(r.get("categories") or [])
incat = {i for i, x in agents.items() if x.get("category") in cats} | alts
cands = set(agents)
if not cands: sys.exit(1)
def kw(x):
    name = (x.get("name", "") + " " + x["id"]).lower(); tags = " ".join(x.get("tags") or []).lower(); desc = (x.get("description") or "").lower()
    nw = set(re.split(r"[^a-z0-9+#]+", name))
    hit = lambda w: ((3 if (w in nw or w + "s" in nw) else 1 if w in name else 0) + (2 if w in tags else 0) + (1 if w in desc else 0)) * idf(w)
    return round(sum(hit(w) for w in words) + 2 * sum(hit(w) for w in need), 1)
import math
_docs = [((x.get("name", "") + " " + x["id"] + " " + " ".join(x.get("tags") or []) + " " + (x.get("description") or "")).lower()) for x in agents.values()]
_idf = {}
def idf(w):
    # rare words (voiceover, ffmpeg) count more than common ones (design, code, expert); 1.0 = average
    if w not in _idf:
        df = sum(1 for d in _docs if w in d)
        _idf[w] = 0 if df == 0 else min(3.0, math.log((len(_docs) + 1) / df) / 2)
    return _idf[w]
def total(i): return (3 if i == default else 0) + (1 if i in incat else 0) + kw(agents[i])
rows = sorted((-total(i), 0 if i == default else 1, i) for i in cands)
best = rows[0][2]; k = kw(agents[best]); score = total(best)
why = "role default" if best == default and k == 0 else f"{'default + ' if best == default else ''}catalog keyword match ({k})"
alt = ",".join(x[2] for x in rows[1:3] if -x[0] > 1)
out = f"soul={best} role={role} score={score} kw={k}" + (f" alts={alt}" if alt else "") + f" reason={why}"
print(out)
if not a.no_log:
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        open(LOG, "a").write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "agent": a.agent, "role": role, "job": a.job[:120], "ask": a.ask[:200], "need": a.need[:120], "soul": best, "score": score, "kw": k, "default": default, "reason": why}) + "\n")
    except Exception: pass
PY
