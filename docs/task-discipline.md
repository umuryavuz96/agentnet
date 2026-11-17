# Jobs, plans and task discipline

An agent works on a **job**. A job has a **plan** of a few steps, and it closes with the agent's done report. agentnet keeps the plan,
checks the proof on each closed step, and scores how the plan was kept.

## The model

| Thing | What it is | Who opens it | How it closes |
|---|---|---|---|
| Job | One piece of work with a goal and (usually) a brief | The spawn, or the boss with `job_open` | `report` with state `done` or `failed`, or the despawn |
| Step | One outcome of the plan, shown as `<job>.<n>` (`1.3`) | `plan_set`, the brief, `step_add` | `step_done` with evidence, or `step_drop` with a reason |
| Ask | A `task` message from the boss or root while a job runs | The message | A reply with `reply_to`, a `step_add` that names it, the done report, or root (`ask_close`) |

New scope is a new job, not more steps on the old one. A follow-up ask ("the header is cut") needs no step: answer it with `reply_to`.

## The tools

| Tool | Does | Refused when |
|---|---|---|
| `plan_set(steps[])` | Sets the whole plan. Step 1 becomes active. | More than 7 steps (or the job's `max_steps`, up to 12); a step is already closed; the plan was set and adjusted once already; the job is closed |
| `step_done(evidence[], note?)` | Closes the active step; the next open step becomes active. | No evidence line; no open step |
| `step_add(text, because)` | Adds a step after the active one. `because` is the id of a message from the boss or root, or `self`. | 12 steps in the job; a third step of the agent's own; `because` is not a message to the agent from its boss or root |
| `step_drop(n, reason)` | Drops an open step. | No reason |
| `job_open(agent, goal, brief?, steps?, max_steps?)` | Boss or root: a new job on a live agent. | The agent's job is still open; the caller is not its boss or root |
| `report(state=done)` | Closes the job. The server adds the plan summary to the report. The report is never a step. | A step is still open |

Every refusal is written to the agent's event log as `Refused` with the rule (`plan`, `evidence`, `because`, `self-cap`, `step-cap`,
`drop-reason`, `no-step`, `job-closed`, `job-open`, `report-open-steps`, `gate`), so refusals can be counted.

A step that reads like a chore ("read the brief", "commit", "final report") is a warning on `plan_set`, not a refusal.
When the steps added later pass half of the plan, root gets one message: open a new job or re-brief.

### Evidence

Each line is `kind: value`. The server checks what it can and stores the result as `ok` (true, false, or null when it cannot tell).
Evidence it cannot find is kept and shown as "not verified"; it does not count as verified in the score.

| Kind | Value | Checked as |
|---|---|---|
| `commit` | a hash, or `<hash> <absolute repo path>` | the commit exists in the agent's project (or the named repo) |
| `file`, `shot` | a path (relative to the project, absolute, or `~/`) | the file exists and is not empty |
| `check` | the result line of a check | it says PASS, `0 fail` or `Validation passed`, and no FAIL |
| `msg` | a message id | the agent sent or got that message |
| `none` | why there is no proof | never verified; shown as given |

### The plan from the brief

A brief with a `## Steps` section of numbered lines gives the plan at spawn (`spawn-agent.sh --brief FILE`, or the first `BRIEF*.md` file named in the
boot prompt; the `spawn` tool takes `brief`). The agent may adjust it once with `plan_set` before it closes its first step. A brief with more
steps than the plan size sets no plan and returns a warning. `--max-steps N` (up to 12) is for a long recipe.

### The old tools

`task_add`, `task_start` and `task_done` still work, so agents that run today do not break:

- A list that was made with them before this change keeps working as it did, with no caps. So does the list of root and of team members, who have no job that closes.
- On any other agent, `task_add` follows the plan rules (the first list is the plan, later titles are `step_add`), `task_start` does nothing, and `task_done` closes the step with the evidence `none: old tool`.
- The built-in todo list of a session is mirrored only onto such an old list (and for root and team members). It never opens or grows a plan.

## The work gate

The mod asks `GET /gate` before every tool except the agentnet tools, `ToolSearch` and the tools that only read (`Read`, `Grep`, `Glob`).
The gate asks one thing: does the agent have a plan. Free: the first `graceMs` (2 min) after spawn, root, team members, sessions without an
agentnet token. A service that does not answer lets the call through. There is no per-step "start" any more: with a plan, one step is always active.

## Close-out

- The done report closes the job. A failed report closes it too: open steps are recorded as left open.
- A despawn closes the open job: the active step and the pending steps are recorded as left open (not as dropped by the agent), and root gets a `warning` with their numbers. Despawn is never blocked.

## The score (0-100)

Over the steps of closed jobs that were planned with the plan tools. The score is the mean of five numbers:

| Number | Share of |
|---|---|
| Work seen | done steps in which the agent ran at least one work tool while the step was active |
| Proof | done steps with at least one piece of evidence the server verified |
| Plan kept | steps that were in the plan (not added later) |
| Not dropped | steps the agent did not drop |
| Closed | steps that were not left open when the job closed |

Shown on the agent panel, on the Scores page (card with the daily trend, and a Discipline column), and by
`agentnet discipline [--day [YYYY-MM-DD]] [--json]`. `--day` also writes the daily snapshot. The server writes the snapshot hourly: one line
per day in `<home>/data/discipline.jsonl`. Lines from before this change carry the older five checks (listed first, started, on time, not
batch-closed, one at a time) and count tasks, not jobs; the two series are not comparable, and the chart marks the day of the change.

## Grades

Root grades a closed **job** (1-5): `grade(agent, grade, note?, rework?, owner_rounds?, job?, gen?)`. A name can be used by several runs
(`web-dev-2#1`, `web-dev-2#2`); `gen` names the run and `job` the job number. Without them the grade lands on the newest closed job of the
newest run. A wrong `job` or `gen` is refused, and the answer lists the closed jobs. The grade is stored as given: discipline is its own
number and no longer lowers it. Per-task records from before this change stay readable (`task_id` grades one of them).

## Switches

`<home>/config/task-discipline.json`: `workGate` (true), `blockDoneReport` (true), `graceMs` (120000). `AGENTNET_TASK_STRICT=0` turns the
gate and the report rule off.
