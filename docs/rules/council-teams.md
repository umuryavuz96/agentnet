# Council teams

Use a council for team work: a job that needs more than one point of view and more than one person to build. Agents with different characters discuss the job. One or two agents then merge the result into the product.

`agentnet council` plans and spawns the team. The triage hook tells the director when to use it.

## When

Form a council when the `[triage]` line says `route=team`. The line carries `council=<angle>,<angle>,<angle> integrators=<role>,<role>`.

Do not form a council for chat, lookups, one-off edits, ops tasks or small background jobs.

## Shape (at most 8 agents)

| Part | Count | Does |
|---|---|---|
| Moderator (`architect-1`) | 1 | Opens each topic, runs the debate, writes the Decision and the integration tasks. |
| Council members | 3 to 5 | One per angle, chosen for the job. They think, argue and mock up. They never write product code or build. |
| Integrators | 1 to 2 | The only agents that write code and build. They merge the Decision into the product. |

Pick a persona and a model per member with `agentnet pick-soul` and `agentnet pick-model`. `agentnet council` does this for you.

Names: a council member is named after its angle plus a number, for example `api-designer-1` or `security-1`. Pass `name=angle` pairs to give a member a short name. Integrators keep their role name (`backend-1`, `web-dev-1`). The moderator is always `architect-1`.

## Command

```
agentnet council <project> <team> "<job>" "<name=angle,name=angle,...>" "<integrator roles>" [--go] [--ask "<the user's words>"]
```

Without `--go` it prints the plan only: one line per member with model, effort and persona. Check the plan, then run it again with `--go`.

With `--go` it writes `<project>/docs/TEAM-<date>.md` (the roster) and spawns the moderator first, then the rest. The moderator reports to the root agent. Everyone else reports to the moderator.

## Topic files

Path: `<project>/docs/council/<nn>-<topic>.md`. Sections, in order:

1. **Question**, opened by the moderator, with the plan items it covers.
2. **Positions**: one per council member, with mock-ups where useful.
3. **Replies**: each member answers the others (agree, disagree, improve). At least one real round of disagreement.
4. **Decision**: what, why, which ideas won. Moderator only.
5. **Integration tasks**: who builds what. After the build, add before and after results and a council review.

## Heat rules

- One build at a time on the machine. Use a lock, for example `lockf -k /tmp/<project>-build.lock nice -n 15 <build command>`.
- Only integrators build.
- Respect the usage mode (see model-routing.md). In eco mode run at most 3 agents and 1 team.

## House rules for every member

- Keep a live task list (`mcp__agentnet__task_add`, `task_start`, `task_done`).
- Local commits only. Never push.
- No posts, messages, emails or purchases unless the brief says so.
- Never print secrets.
- Report to your boss when a milestone is done or you are stuck.
- The director grades the result, then despawns the team with `agentnet despawn <name>`.
