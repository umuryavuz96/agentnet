# Task discipline

agentnet measures how well each agent keeps its task list, and can refuse work when it does not. Spec: `docs/internal/SPEC-task-discipline-2026-11-10.md`.

## The score (0-100)

Per finished task, five checks. The score is the share of checks that held, over finished tasks plus tasks left open when an agent was despawned (those fail every check).

| Check | Holds when |
|---|---|
| Listed first | the task list was made before the first real work |
| Started before done | the task was started (`task_start`) before it was done |
| Started on time | started within 10 min of the previous done (or the first add) |
| Not batch-closed | not done within 60 s of the previous done, unless the task ran longer than 60 s |
| One at a time | no other task of the agent was in progress at the same time |

Shown on the agent panel (Score block), on the Scores page (card with the daily trend, and a Discipline column), and by `agentnet discipline [--day [YYYY-MM-DD]] [--json]`. `--day` also writes the daily snapshot. The server writes the snapshot hourly: one line per day in `<home>/data/discipline.jsonl`.

First data point (2026-11-10, 993 finished tasks, before the strict rules): score 63. Listed first 68%, started 54%, on time 52%, not batch-closed 51%, one at a time 89%. Last 24 h (502 tasks): 59.

## The strict rules

Each has a switch in `<home>/config/task-discipline.json` (all default on). `AGENTNET_TASK_STRICT=0` turns all of them off.

| Rule | Switch | Effect |
|---|---|---|
| B1 | `strictDone` | `task_done` on a task never started is refused: "start it first". |
| B2 | `workGate` | The mod asks `GET /gate` before every tool except `mcp__agentnet__*` and `ToolSearch`. No task in progress: refused ("add your tasks first" when the list is empty). Free: the first `graceMs` (2 min) after spawn, root, team members, sessions without an agentnet token. A service that does not answer lets the call through. |
| B3 | `maxInProgress` (1; 0 = off) | `task_start` while another task is in progress is refused: "finish or done task N first". Set 2 for parallel waits. |
| B4 | `blockDoneReport` | `report state=done` is refused while tasks are open. Despawn with open tasks returns a `warning` to root; the card shows "N open at close". Despawn is never blocked. |
| B5 | `gradePenalty` (0.5 per flag), `gradePenaltyCap` (2) | When root grades, each failed check of that task lowers the stored grade. `grade_raw` keeps root's grade; `penalty` the points taken off. The panel shows `5→4.5`. |

Other numbers: `graceMs`, `batchMs` (60 s), `onTimeMs` (10 min).
