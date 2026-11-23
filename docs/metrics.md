# Metrics: is the system getting better?

`agentnet metrics` and the **Trends** tab of the Scores page show closed jobs grouped by kind of work and by week (Monday, UTC), last 8 weeks.

Per kind and week:

| Column | Meaning |
|---|---|
| n | jobs closed that week. Under 3 the point is thin (marked `*`, drawn hollow) |
| wall min | median minutes from job open to close |
| cost $ | median dollars per job (jobs without a priced model are left out) |
| rework | share of jobs root flagged for rework |
| rounds | mean owner rounds per job, over jobs where it was recorded |
| owner caught | share of jobs where the owner came back with a problem: owner rounds above 0, or a complaint the owner-learning step linked to the job. Counted over jobs where that is known, never over unknown ones |

Root's grade is not used: it is root's own opinion. Owner rounds and complaints come from the owner.

**Kinds** come from the role name (`web UI`, `mobile`, `backend`, `design`, `game`, `research & plan`, `ops`). A role that matches nothing is sorted by its goal text, then falls to `other`. Put your own rules in `$AGENTNET_HOME/config/metrics-kinds.json`, checked first: `{"kind": ["regex", ...]}`.

**Units.** `job` is a closed job (since the job model). `task` is the older per-task rows (`agentnet metrics --tasks`, "Old tasks" in the panel); the two are never mixed in one trend.

**Daily charts.** The `daily` field of the JSON (and two charts on top of the Trends tab) gives tokens and dollars per closed job, one point per UTC day for the last 14 days, per kind of work plus an "All work" line. A day's value is the median over that day's jobs that have the number; a day with no job is `null`, never 0; fewer than 3 jobs sets `few`. `first` and `last` are the medians over all jobs of the first 7 and the last 7 days, and the sentence under each chart is built from them (lower is better).

**Sparse fields.** The last lines of the output give the share of rows with wall time, cost, tokens and owner rounds, and name any under 60%.

```
agentnet metrics [--weeks N] [--tasks] [--json]
GET /v1/panel/metrics?unit=job|task&weeks=1..26
```
