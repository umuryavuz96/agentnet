// One reading of an agent's job plan. The panel's plan, the card line and the team panel all draw from it, so the three
// never disagree. Pure: no clock, no fetch.
import type { AgentRow, Ask, Evidence, Job, Step } from "./net";

/** The current job (the last one), or null on an agent that has none yet or was folded before jobs existed. */
export const curJob = (a: Pick<AgentRow, "jobs">): Job | null => a.jobs?.at(-1) ?? null;
/** Jobs before the current one, newest first. */
export const earlierJobs = (a: Pick<AgentRow, "jobs">): Job[] => (a.jobs ?? []).slice(0, -1).reverse();
export const openAsks = (a: Pick<AgentRow, "asks">): Ask[] => (a.asks ?? []).filter((k) => k.closedAt == null);

export interface PlanCount {
  /** The fixed total: steps in the plan when it was set. */ plan: number;
  /** Done steps of the plan; added steps do not count here. */ done: number;
  /** Steps added after the plan was set. */ added: number;
  /** The plan grew by more than half of what it started with. */ grew: boolean;
  /** Dropped by the agent (not the ones the service closed out). */ dropped: number;
  /** Still open when the job closed. */ unfinished: number;
}
export function planCount(j: Job): PlanCount {
  const added = j.steps.filter((s) => s.added).length;
  return { plan: j.plan, done: j.steps.filter((s) => !s.added && s.status === "done").length, added, grew: added > j.plan / 2,
    dropped: j.steps.filter((s) => s.status === "dropped" && !s.unfinished).length, unfinished: j.steps.filter((s) => s.unfinished).length };
}
/** "3/6": progress never counts a step that was added later. */
export const countText = (c: PlanCount) => `${c.done}/${c.plan}`;
/** "2.4": job 2, step 4. */
export const stepNo = (j: Job, s: Step) => `${j.id}.${s.n}`;

/** Steps in the order they are drawn: the plan first, then the ones added later, each group by number. */
export function planSteps(j: Job): { brief: Step[]; added: Step[]; all: Step[] } {
  const by = (x: Step, y: Step) => x.n - y.n, brief = j.steps.filter((s) => !s.added).sort(by), added = j.steps.filter((s) => s.added).sort(by);
  return { brief, added, all: [...brief, ...added] };
}
export const activeStep = (j: Job | null): Step | null => j?.steps.find((s) => s.status === "active") ?? null;

export type StepLook = "done" | "active" | "pending" | "dropped" | "unfinished";
/** How a step is drawn. A step the service closed out reads "unfinished" only when it was the one in work. */
export const stepLook = (s: Step): StepLook => (s.status === "dropped" && s.unfinished && s.activatedAt != null ? "unfinished" : s.status);

/** The right column of a done step: its time when the service saw work in it, "nowork" when it saw none, null when it
 *  makes no claim (a job run with the old tools, a step that was not counted, missing stamps). Never a time for a step
 *  with no work under it. */
export function stepTime(j: Job, s: Step): { ms: number } | "nowork" | null {
  if (s.status !== "done" || s.workCalls == null) return null;
  if (s.workCalls === 0) return j.legacy ? null : "nowork";
  return s.activatedAt != null && s.closedAt != null ? { ms: Math.max(0, s.closedAt - s.activatedAt) } : null;
}
/** A job run with the old task tools draws as the plain list: no origin chips, no proof, no "added later" line. */
export const plain = (j: Job) => j.legacy === true;
/** The proof shown on a step: none on open or dropped steps, none on a job planned with the old tools. */
export const proofs = (j: Job, s: Step): Evidence[] => (j.legacy || s.status !== "done" ? [] : s.evidence);

const OUT = { done: "done", blocked: "blocked", failed: "failed", dropped: "dropped" } as const;
/** "Job 2 done", "Job 2 blocked": the word for a closed job; null while it is open. */
export const jobWord = (j: Job): string | null => (j.closedAt == null ? null : `Job ${j.id} ${OUT[j.outcome ?? "done"]}`);

/** What a card says in the place of the status sentence when the agent has a planned job: the step in work, or how the
 *  job ended (`at` = the step it stopped in, when it was closed out). Null: no plan to speak of, the sentence stays. */
export type PlanLine = { no: string; text: string } | { ended: Job; at: string | null };
export function planLine(a: Pick<AgentRow, "jobs">): PlanLine | null {
  const j = curJob(a);
  if (!j || j.legacy || !j.steps.length) return null;
  if (j.closedAt != null) { const s = j.steps.find((x) => stepLook(x) === "unfinished"); return { ended: j, at: s ? stepNo(j, s) : null }; }
  const s = activeStep(j);
  return s ? { no: stepNo(j, s), text: s.text } : null;
}
/** How an ended job reads on one line. `ago` is the time since it closed, already formatted. */
export const endedText = (l: { ended: Job; at: string | null }, ago: string) => `Job ${l.ended.id} ${l.ended.outcome}` + (l.at ? ` at step ${l.at}` : ` · reported ${ago} ago`);
