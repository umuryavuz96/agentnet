// One reading of where an agent is in its task list (map board 10-agent-trail, view()). The card line, the peek and the
// full trail all draw from it, so the three sizes never disagree.
import type { AgentRow, Check, Job, Step, Task } from "./net";
import { phrase } from "./trail";
import { countText, curJob, jobWord, planCount, planSteps, type PlanCount } from "./plan";

export type TrailMode = "work" | "gate" | "block" | "reply" | "idle" | "none" | "closed";
/** One row of the trail: a task of the old list, or a step of the job's plan (`step` is set, and it can be dropped). */
export interface TStep { id: number; text: string; status: Task["status"] | "dropped"; startedAt?: number; doneAt?: number; step?: Step }
/** `job` is set when the agent has one. `plan` is set for a planned job: then `steps` are its steps as drawn (the plan
 *  first, then the added ones, dropped ones included) and `count` is done plan steps over the fixed total. A job run with
 *  the old task tools, and an agent without a job, read as the plain list: rows in the order they came, done over all. */
export interface TrailView { n: number; done: number; cur: number; count: string; mode: TrailMode; word: string; since: number | null; check: Check | null; job: Job | null; plan: PlanCount | null; steps: TStep[] }

/** The rows of an agent's trail and the job they belong to. An agent folded before jobs existed has only its task list. */
export function trailSteps(a: AgentRow): { job: Job | null; steps: TStep[] } {
  const job = curJob(a);
  if (!job) return { job: null, steps: a.tasks ?? [] };
  return { job, steps: (job.legacy ? job.steps : planSteps(job).all).map((s) => ({ id: s.n, text: s.text, status: s.status === "active" ? "in_progress" : s.status, step: s,
    ...(s.activatedAt != null ? { startedAt: s.activatedAt } : {}), ...(s.status === "done" && s.closedAt != null ? { doneAt: s.closedAt } : {}) })) };
}

export function trailView(a: AgentRow, check: Check | null = null): TrailView {
  const { job, steps: t } = trailSteps(a), n = t.length, done = t.filter((x) => x.status === "done").length, pc = job ? planCount(job) : null, plan = job?.legacy || !n ? null : pc;
  let cur = t.findIndex((x) => x.status === "in_progress");
  const v: TrailView = { n, done, cur, count: plan ? countText(plan) : n ? `${done}/${n}` : "", mode: "idle", word: "Idle", since: a.stateSince ?? null, check, job, plan, steps: t };
  // steps still open: on a closed job the service has closed them out, so they are counted as unfinished
  const open = pc && job?.closedAt != null ? pc.unfinished : t.filter((x) => x.status === "pending" || x.status === "in_progress").length;
  if (a.life === "gone" || a.life === "failed") { v.mode = "closed"; v.word = open ? `Closed · ${open} open` : "Closed"; v.since = a.lifeSince ?? a.stateSince; }
  else if (a.state === "blocked" || a.reported?.blockedOn) { v.mode = "block"; v.word = "Blocked"; }
  else if (check) { v.mode = "gate"; v.word = "Waiting for you"; v.since = check.createdAt; }
  else if (a.state === "waiting" && a.lastMsg?.dir === "out" && a.lastMsg.kind === "question") { v.mode = "reply"; v.word = `Waits for ${a.lastMsg.peer}`; v.since = a.lastMsg.at; }
  else if (!n) { v.mode = "none"; v.word = "No plan yet"; }
  else if (a.state !== "working" || cur < 0) { v.mode = "idle"; v.word = job ? jobWord(job) ?? (open ? "Idle" : "Not reported yet") : done === n ? `All ${n} done` : "Idle"; }
  else { v.mode = "work"; v.word = a.action ? phrase(a.action) : "Working"; v.since = t[cur].startedAt ?? a.action?.at ?? null; } // the timer counts the step, so it does not restart on every tool call
  if (cur < 0 && n && v.mode !== "idle" && v.mode !== "none" && v.mode !== "closed") { const p = job ? t.findIndex((x) => x.status === "pending") : -1; cur = v.cur = p >= 0 ? p : Math.min(done, n - 1); }
  return v;
}

/** Live timer text: 26s, 3m 12s, 1h 04m. */
export const dur = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); if (s < 60) return s + "s"; if (s < 3600) return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s"; return Math.floor(s / 3600) + "h " + String(Math.floor(s / 60) % 60).padStart(2, "0") + "m"; };
/** Short span: 8s, 2m, 3h. */
export const short = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m" : Math.round(s / 3600) + "h"; };
export const SEG: Record<TrailMode, string> = { work: "cur", gate: "gate", block: "block", reply: "gate", idle: "idle", closed: "idle", none: "" };
export const WORD: Record<TrailMode, string> = { work: "on", gate: "gate", block: "block", reply: "gate", idle: "muted", none: "muted", closed: "muted" };
