#!/usr/bin/env bash
# council.sh <project> <team> "<job>" "<name=angle,name=angle,...>" "<integrator roles>" [--go] [--ask "<words>"]
# Plans (default) or spawns (--go) a council team: architect-1 moderator, 3-5 persona angles, 1-2 integrators.
# Rules: $AGENTNET_RULES_DIR (default docs/rules in this repo): council-teams.md, model-routing.md.
# Routing: pick-model.sh + pick-soul.sh per member. Spawn: spawn-agent.sh. Boss of the moderator: $AGENTNET_ROOT_NAME (default root).
set -euo pipefail
[ $# -ge 5 ] || { sed -n '2,3p' "$0"; exit 2; }
PROJ=$1 TEAM=$2 JOB=$3 ANGLES=$4 INTEG=$5; shift 5
GO=0 ASK=$JOB
while [ $# -gt 0 ]; do case $1 in --go) GO=1;; --ask) ASK=${2:?--ask needs a text}; shift;; *) echo "error: unknown option $1" >&2; exit 2;; esac; shift; done
L="$(cd "$(dirname "$0")" && pwd)"; SP="$L/spawn-agent.sh"
RULES="${AGENTNET_RULES_DIR:-$(cd "$L/.." && pwd)/docs/rules}"
ROOTNAME="${AGENTNET_ROOT_NAME:-root}"
PROJ=$(cd "${PROJ/#\~/$HOME}" && pwd); DATE=$(date +%F)
slug() { echo "$1" | tr 'A-Z _' 'a-z--' | tr -cd 'a-z0-9-'; }
trim() { sed 's/^ *//;s/ *$//' <<<"$1"; }
IFS=',' read -ra A <<<"$ANGLES"; IFS=',' read -ra I <<<"$INTEG"
[ ${#A[@]} -ge 3 ] && [ ${#A[@]} -le 5 ] || echo "warn: council should have 3-5 angles (got ${#A[@]})" >&2
[ $((${#A[@]} + ${#I[@]} + 1)) -le 8 ] || { echo "error: max 8 agents" >&2; exit 1; }

# rows: name|kind|role(for routing)|angle|scope|novelty|risk
ROWS=("architect-1|moderator|architect|moderator decision synthesis|4|2|1")
# Council members are named after their persona: "mcp-architect=mcp server architecture" gives mcp-architect-1; a bare angle uses its slug.
for a in "${A[@]}"; do a=$(trim "$a"); nm="${a%%=*}"; [ "$nm" = "$a" ] || a="${a#*=}"; ROWS+=("$(slug "$nm")-1|council|reviewer|$a|2|2|0"); done
for r in "${I[@]}"; do r=$(slug "$(trim "$r")"); ROWS+=("$r-1|integrator|$r|$r build integrate|3|2|1"); done

PLAN=()
for row in "${ROWS[@]}"; do
  IFS='|' read -r name kind role need sc nv rk <<<"$row"
  m=$("$L/pick-model.sh" --role "$role" --scope "$sc" --novelty "$nv" --risk "$rk" --ask "$ASK" --no-log 2>&1 | head -1) || true
  model=$(sed -n 's/.*model=\([a-z]*\).*/\1/p' <<<"$m"); eff=$(sed -n 's/.*effort=\([a-z]*\).*/\1/p' <<<"$m")
  s=$("$L/pick-soul.sh" --role "$role" --ask "$ASK" --need "$need" --agent "$name" --job "$JOB" --no-log 2>/dev/null | head -1) || true
  soul=$(sed -n 's/^soul=\([^ ]*\).*/\1/p' <<<"$s")
  printf '%-22s %-10s model=%-6s effort=%-6s soul=%s\n' "$name" "$kind" "${model:-?}" "${eff:-?}" "${soul:--}"
  PLAN+=("$name|$kind|${model:-}|${eff:-}|${soul:-}|$need")
done
echo "files: $PROJ/docs/council/ , $PROJ/docs/TEAM-$DATE.md   (${#ROWS[@]} agents)"
[ $GO -eq 1 ] || { echo "dry-run: add --go to spawn (moderator first)"; exit 0; }

mkdir -p "$PROJ/docs/council"
{ echo "# Council team $TEAM ($DATE)"; echo; echo "Job: $JOB"; echo; echo "Rules: $RULES/council-teams.md. Topics in docs/council/<nn>-<topic>.md."
  echo; echo "| Agent | Kind | Angle / role | Model | Soul |"; echo "|---|---|---|---|---|"
  for p in "${PLAN[@]}"; do IFS='|' read -r nm k md ef so nd <<<"$p"; echo "| $nm | $k | $nd | $md/$ef | ${so:--} |"; done
  echo; echo "Council never builds. Only integrators build: one build at a time. Local commits only, never push."; } > "$PROJ/docs/TEAM-$DATE.md"

# boss: moderator reports to the root agent, everyone else to architect-1
for p in "${PLAN[@]}"; do
  IFS='|' read -r nm k md ef so nd <<<"$p"
  if [ "$nm" = architect-1 ]; then boss=$ROOTNAME; else boss=architect-1; fi
  case $k in
    moderator) T="You are the MODERATOR and decider. Open docs/council/<nn>-<topic>.md per topic, run the debate (positions, replies, at least one disagreement), write the Decision and integration tasks, review integrator output. Report to $ROOTNAME with mcp__agentnet__report.";;
    council) T="You are a COUNCIL member, angle: $nd. Write your position in the topic file, then reply to the others (agree/disagree/improve). Never write product code, never build. Report to architect-1 (mcp__agentnet__send).";;
    *) T="You are an INTEGRATOR. Build only what the moderator's Decision says; one build at a time. Post before/after in the topic file. Report to architect-1 (mcp__agentnet__send).";;
  esac
  "$SP" "$nm" --project "$PROJ" --boss "$boss" --job "$JOB ($k)" ${md:+--model "$md"} ${so:+--soul "$so"} \
    --boot-prompt "Council team $TEAM. Job: $JOB. Read $RULES/council-teams.md and $PROJ/docs/TEAM-$DATE.md first. Effort: ${ef:-medium}. $T Rules: task list first (mcp__agentnet__task_add), local commits only, NEVER push, no posts/messages/emails/purchases, never print secrets."
done
