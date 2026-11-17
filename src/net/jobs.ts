// agentnet jobs: the unit above the task list. A job has a goal, a small plan of steps that comes from the brief, and an end.
// This file is pure: the fold of the job events (store.ts calls foldJob for every event) and the plan rules the routes enforce.
// The old task events (TaskAdded, TaskStarted, TaskDone) fold onto a job too, so the old tools keep working: a job planned with
// them is `legacy` and has no caps. Doc: docs/task-discipline.md.
import type { Event, Snapshot, Task } from "./store";

export type EvidenceKind = "commit" | "file" | "check" | "shot" | "msg" | "none";
export const EVIDENCE_KINDS: EvidenceKind[] = ["commit", "file", "check", "shot", "msg", "none"];
/** `ok`: what the server could verify (true / false), null when it cannot be checked (`none`, an unknown project). */
export interface Evidence { kind: EvidenceKind; value: string; ok: boolean | null }
export type Origin = "brief" | "boss" | "self";
export type StepStatus = "pending" | "active" | "done" | "dropped";
export interface Step {
  n: number; text: string; origin: Origin; originMsg: number | null; status: StepStatus;
  /** Added after the plan was set: it does not count in the plan total. `after`: the step that was active when it was added (it runs next). */
  added?: true; after?: number;
  evidence: Evidence[]; note?: string; /** Why it was dropped. */ reason?: string;
  /** Still open when the job closed (a failed report, a despawn): closed by the server, not by the agent. */
  unfinished?: true;
  addedAt: number; activatedAt?: number; closedAt?: number;
  /** Work tool calls the server saw while the step was active. Absent on steps taken over from an old task list. */
  workCalls?: number;
}
export type Outcome = "done" | "blocked" | "failed" | "dropped";
export interface Job {
  id: number; goal: string | null; brief: string | null; openedBy: string; openedAt: number; closedAt: number | null; outcome: Outcome | null;
  /** Steps in the plan when it was set: the fixed total. Steps added later are counted apart. */
  plan: number; /** A plan larger than PLAN_MAX that root allowed for this job. */ planMax?: number;
  /** Times the plan was set: once from the brief (or by the agent), and one adjust. */
  planSets?: number;
  /** Planned with the old task tools: no caps, no evidence expected. */
  legacy?: true;
  steps: Step[]; grade?: number | null; gradeNote?: string | null;
}
/** A follow-up ask: a task message from the boss or root. Open until the agent answers with reply_to, turns it into a step, or the job is reported. */
export interface Ask { id: number; from: string; subject: string; at: number; closedAt: number | null; closedBy?: "reply" | "report" | "step" | "root"; step?: number }

export const PLAN_MAX = 7, STEPS_MAX = 12, SELF_MAX = 2, TEXT_MAX = 200, ASKS_KEEP = 40;
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown) => (typeof x === "string" && x ? x : null);
const isWork = (tool: unknown) => typeof tool === "string" && !tool.startsWith("mcp__agentnet__") && tool !== "ToolSearch";

// ---------- reading ----------
/** The jobs of a fold. A fold from before jobs existed that has a task list gets one legacy job made from it. */
export function jobsOf(s: Pick<Snapshot, "jobs" | "tasks" | "goal" | "spawnedAt">): Job[] {
  if (s.jobs) return s.jobs;
  if (!s.tasks.length) return [];
  const steps: Step[] = s.tasks.map((t) => ({ n: t.id, text: t.text, origin: "self", originMsg: null, status: t.status === "done" ? "done" : t.status === "in_progress" ? "active" : "pending",
    evidence: t.status === "done" ? [OLD_TOOL] : [], addedAt: s.spawnedAt, ...(t.startedAt != null ? { activatedAt: t.startedAt } : {}), ...(t.doneAt != null ? { closedAt: t.doneAt } : {}) }));
  return [{ id: 1, goal: s.goal ?? null, brief: null, openedBy: "old tool", openedAt: s.spawnedAt, closedAt: null, outcome: null, plan: steps.length, legacy: true, steps }];
}
const OLD_TOOL: Evidence = { kind: "none", value: "old tool", ok: null };
/** The open job, or null. */
export const openJob = (s: Pick<Snapshot, "jobs" | "tasks" | "goal" | "spawnedAt">): Job | null => { const l = jobsOf(s).at(-1); return l && l.closedAt == null ? l : null; };
export const activeStep = (j: Job | null): Step | null => j?.steps.find((x) => x.status === "active") ?? null;
export const openSteps = (j: Job) => j.steps.filter((x) => x.status === "pending" || x.status === "active");
export const openAsks = (s: Pick<Snapshot, "asks">): Ask[] => (s.asks ?? []).filter((a) => a.closedAt == null);
/** The old `tasks` view of a job: its steps without the dropped ones. */
export const tasksOf = (j: Job | undefined): Task[] => (j?.steps ?? []).filter((x) => x.status !== "dropped").map((x) => ({ id: x.n, text: x.text, status: x.status === "done" ? "done" : x.status === "active" ? "in_progress" : "pending",
  ...(x.activatedAt != null ? { startedAt: x.activatedAt } : {}), ...(x.status === "done" && x.closedAt != null ? { doneAt: x.closedAt } : {}) }));
/** Counts the card, the report and the score use. `plan` is the fixed total; `planDone` counts only steps of the plan. */
export function jobCounts(j: Job) {
  const by = (st: StepStatus) => j.steps.filter((x) => x.status === st), done = by("done");
  return { plan: j.plan, planDone: done.filter((x) => !x.added).length, added: j.steps.filter((x) => x.added).length, selfAdded: j.steps.filter((x) => x.added && x.origin === "self").length,
    done: done.length, dropped: by("dropped").filter((x) => !x.unfinished).length, unfinished: j.steps.filter((x) => x.unfinished).length, open: openSteps(j).length, total: j.steps.length,
    noWork: done.filter((x) => x.workCalls === 0).length, withEvidence: done.filter((x) => x.evidence.some((e) => e.kind !== "none")).length, verified: done.filter((x) => x.evidence.some((e) => e.ok === true)).length };
}

// ---------- the plan rules (the routes refuse with these messages) ----------
/** A step that is ceremony, not an outcome: report, status, read the brief, commit. plan_set warns about these. */
export const isCeremony = (text: string) => /^\s*(final\s+|send\s+(the\s+)?|write\s+(the\s+)?)?(report|status(\s+line)?|read\s+(the\s+)?(brief|rules?)|commit(\s+and\s+report)?)\b/i.test(text);
export const cleanSteps = (x: unknown): string[] => (Array.isArray(x) ? x : []).map((t) => String((t && typeof t === "object" ? (t as { text?: unknown }).text : t) ?? "").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX)).filter(Boolean);
/** Why this plan cannot be set, or null. */
export function planError(j: Job | null, steps: string[]): string | null {
  const max = j?.planMax ?? PLAN_MAX;
  if (!steps.length) return "agentnet: plan_set needs steps: 1 to " + max + " short outcomes, taken from the brief.";
  if (steps.length > max) return `agentnet: a plan has at most ${max} steps and this has ${steps.length}. Merge them into outcomes (a fix or a review comment is not a step; the report is not a step).`;
  if ((j?.planSets ?? 0) >= 2 && !j?.legacy) return "agentnet: the plan was set and adjusted once already. From here: step_add for new scope from your boss, step_drop for a step that no longer applies.";
  if (j?.steps.some((x) => x.status === "done")) return "agentnet: the plan is fixed once a step is closed. Use step_add for new scope from your boss, or step_drop for a step that no longer applies.";
  return null;
}
/** Why a step cannot be added, or null. `origin` is already checked against the message by the caller. */
export function addError(j: Job, origin: Origin, text: string): string | null {
  if (!text) return "agentnet: step_add needs a text.";
  if (j.legacy) return null;
  if (j.steps.length >= STEPS_MAX) return `agentnet: this job has ${j.steps.length} steps and the cap is ${STEPS_MAX}. Report what is done and ask your boss for a new job (job_open) for the rest.`;
  if (origin === "self" && jobCounts(j).selfAdded >= SELF_MAX) return `agentnet: you added ${SELF_MAX} steps of your own to this job already. More scope needs a message from your boss: pass its id as because.`;
  return null;
}
/** The plan as text for the report that closes the job (and for the agent after each call). */
export function planSummary(j: Job, asks: Ask[] = []): string {
  const c = jobCounts(j), mark: Record<StepStatus, string> = { done: "done", active: "open", pending: "open", dropped: "dropped" };
  const left = c.unfinished ? `, ${c.unfinished} left open` : "";
  const ev = (x: Step) => x.evidence.length ? " [" + x.evidence.map((e) => `${e.kind}${e.kind === "none" ? ": " + e.value : " " + e.value.slice(0, 60)}${e.ok === true ? " ok" : e.ok === false ? " NOT FOUND" : ""}`).join("; ") + "]" : "";
  const lines = j.steps.map((x) => `${j.id}.${x.n} ${x.unfinished ? "left open" : mark[x.status]}: ${x.text}${x.added ? ` (added, ${x.origin}${x.originMsg ? " #" + x.originMsg : ""})` : ""}${x.status === "dropped" ? ` (${x.reason ?? "no reason"})` : ev(x)}${x.status === "done" && x.workCalls === 0 ? " (no work seen)" : ""}`);
  const open = asks.filter((a) => a.closedAt == null);
  return [`Plan of job ${j.id}: ${c.planDone}/${c.plan} done${c.added ? `, +${c.added} added` : ""}${c.dropped ? `, ${c.dropped} dropped` : ""}${left}`, ...lines, ...(open.length ? [`Open asks: ${open.map((a) => `#${a.id} ${a.subject}`).join("; ")}`] : [])].join("\n");
}

// ---------- the brief ----------
/** The numbered lines under a `## Steps` heading of a brief (any heading level; ends at the next heading). */
export function briefSteps(md: string): string[] {
  const lines = md.split("\n"), at = lines.findIndex((l) => /^#{1,6}\s+steps\b/i.test(l.trim()));
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(l.trim())) break;
    const m = /^\s*\d+[.)]\s+(.+)$/.exec(l);
    if (m) out.push(m[1]!.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX));
  }
  return out.filter(Boolean);
}

// ---------- the fold ----------
/** Make sure an open job with pending steps has one active step. `after`: the step that just closed (a step added after it runs first). */
function activate(j: Job, at: number, after?: number): Job {
  if (j.legacy || j.closedAt != null || j.steps.some((x) => x.status === "active")) return j; // the old tools say which task is in work themselves
  const pend = j.steps.filter((x) => x.status === "pending"), next = pend.find((x) => after != null && x.after === after) ?? pend[0];
  return next ? { ...j, steps: j.steps.map((x) => (x === next ? { ...x, status: "active", activatedAt: x.activatedAt ?? at } : x)) } : j;
}
const closeStep = (x: Step, at: number, evidence: Evidence[], note: string | null): Step => ({ ...x, status: "done", closedAt: at, evidence, ...(note ? { note } : {}) });
const evidenceOf = (x: unknown): Evidence[] => (Array.isArray(x) ? x : []).filter((e): e is Evidence => !!e && typeof e === "object" && EVIDENCE_KINDS.includes((e as Evidence).kind) && typeof (e as Evidence).value === "string")
  .map((e) => ({ kind: e.kind, value: e.value.slice(0, 300), ok: e.ok === true ? true : e.ok === false ? false : null })).slice(0, 6);
const closeAsks = (asks: Ask[] | undefined, at: number, by: Ask["closedBy"], pick: (a: Ask) => boolean, step?: number): Ask[] | undefined =>
  asks?.some((a) => a.closedAt == null && pick(a)) ? asks.map((a) => (a.closedAt == null && pick(a) ? { ...a, closedAt: at, closedBy: by, ...(step != null ? { step } : {}) } : a)) : asks;

/** Fold one event into the jobs, the asks and the old `tasks` view of `n` (a fresh copy of the snapshot: it is changed in place). */
export function foldJob(n: Snapshot, e: Event): void {
  const d = e.data, at = e.ts;
  switch (e.type) {
    case "ToolFinished": { // work seen in the active step (cheap path: no job yet = nothing to count)
      const j = n.jobs?.at(-1);
      if (j && j.closedAt == null && isWork(d.tool) && j.steps.some((x) => x.status === "active")) n.jobs = [...n.jobs!.slice(0, -1), { ...j, steps: j.steps.map((x) => (x.status === "active" ? { ...x, workCalls: (x.workCalls ?? 0) + 1 } : x)) }];
      return;
    }
    case "MessageReceived": { // an ask: a task message from the boss or root
      const id = num(d.msg_id), peer = str(d.peer);
      if (id == null || d.kind !== "task" || !peer || n.name === "root" || (peer !== n.boss && peer !== "root") || n.asks?.some((a) => a.id === id)) return;
      const all = [...(n.asks ?? []), { id, from: peer, subject: String(d.subject ?? d.snippet ?? "").slice(0, 60), at, closedAt: null }];
      n.asks = all.length > ASKS_KEEP ? [...all.filter((a) => a.closedAt == null), ...all.filter((a) => a.closedAt != null).slice(-10)].sort((a, b) => a.id - b.id).slice(-ASKS_KEEP) : all;
      return;
    }
    case "MessageSent": { const to = num(d.reply_to); if (to != null) n.asks = closeAsks(n.asks, at, "reply", (a) => a.id === to); return; }
    case "AskClosed": { const id = num(d.id); n.asks = closeAsks(n.asks, at, "root", (a) => a.id === id); return; }
    case "JobOpened": case "PlanSet": case "StepClosed": case "StepAdded": case "StepDropped": case "StepActivated": case "JobClosed": case "JobGraded":
    case "TaskAdded": case "TaskStarted": case "TaskDone": case "AgentGone": break;
    default: return;
  }
  if (e.type === "AgentGone" && d.reason !== "despawn") return; // only a despawn ends the job: an agent that exits may come back
  let jobs = jobsOf(n), j = jobs.at(-1) ?? null;
  if (j && j.closedAt != null) j = null;
  const put = (x: Job) => { jobs = j ? [...jobs.slice(0, -1), x] : [...jobs, x]; j = x; };
  const open = (by: string, legacy: boolean, goal: string | null = n.goal ?? null, brief: string | null = null, planMax: number | null = null) =>
    put({ id: jobs.length + 1, goal, brief, openedBy: by, openedAt: at, closedAt: null, outcome: null, plan: 0, ...(planMax ? { planMax } : {}), ...(legacy ? { legacy: true as const } : {}), steps: [] });
  const nextN = () => Math.max(0, ...j!.steps.map((x) => x.n)) + 1;
  const close = (outcome: Outcome, why: string) => {
    put({ ...j!, closedAt: at, outcome, steps: j!.steps.map((x) => (x.status === "pending" || x.status === "active" ? { ...x, status: "dropped", closedAt: at, reason: x.status === "active" ? `${why}: unfinished` : why, unfinished: true as const } : x)) });
    n.asks = closeAsks(n.asks, at, "report", () => true);
  };
  switch (e.type) {
    case "JobOpened": if (!j) open(str(d.by) ?? "root", d.legacy === true, str(d.goal) ?? n.goal ?? null, str(d.brief), num(d.planMax)); break;
    case "PlanSet": {
      if (!j) open(str(d.by) ?? n.name, false);
      const texts = cleanSteps(d.steps), origin: Origin = d.origin === "brief" || d.origin === "boss" ? d.origin : "self";
      const { legacy: _l, ...rest } = j!;
      put(activate({ ...rest, plan: texts.length, planSets: (rest.planSets ?? 0) + 1, steps: texts.map((text, i) => ({ n: i + 1, text, origin, originMsg: null, status: "pending", evidence: [], addedAt: at, workCalls: 0 })) }, at));
      break;
    }
    case "StepAdded": case "TaskAdded": {
      if (!j) { if (e.type === "StepAdded") break; open("old tool", true); }
      const id = num(e.type === "TaskAdded" ? d.id : d.n) ?? nextN();
      if (j!.steps.some((x) => x.n === id)) break;
      const act = activeStep(j), grown = !j!.legacy || j!.steps.some((x) => x.status === "done");
      const step: Step = { n: id, text: String(d.text ?? "").slice(0, TEXT_MAX), origin: d.origin === "boss" || d.origin === "brief" ? d.origin : "self", originMsg: num(d.originMsg), status: "pending", evidence: [], addedAt: at, workCalls: 0,
        ...(grown ? { added: true as const } : {}), ...(grown && act ? { after: act.n } : {}) };
      put(activate({ ...j!, plan: grown ? j!.plan : j!.plan + 1, steps: [...j!.steps, step] }, at));
      if (step.originMsg != null) n.asks = closeAsks(n.asks, at, "step", (a) => a.id === step.originMsg, id);
      break;
    }
    case "StepActivated": case "TaskStarted": { // the old task_start: this step is the one in work
      const id = num(e.type === "TaskStarted" ? d.id : d.n);
      if (!j || !j.steps.some((x) => x.n === id && x.status === "pending")) break;
      put({ ...j, steps: j.steps.map((x) => (x.n === id ? { ...x, status: "active", activatedAt: x.activatedAt ?? at } : x.status === "active" ? { ...x, status: "pending" } : x)) });
      break;
    }
    case "StepClosed": case "TaskDone": {
      const id = num(e.type === "TaskDone" ? d.id : d.n) ?? activeStep(j)?.n;
      if (!j || !j.steps.some((x) => x.n === id && (x.status === "pending" || x.status === "active"))) break;
      const ev = e.type === "TaskDone" ? [OLD_TOOL] : evidenceOf(d.evidence);
      put(activate({ ...j, steps: j.steps.map((x) => (x.n === id ? closeStep(x, at, ev, str(d.note)?.slice(0, 300) ?? null) : x)) }, at, id));
      break;
    }
    case "StepDropped": {
      const id = num(d.n);
      if (!j || !j.steps.some((x) => x.n === id && (x.status === "pending" || x.status === "active"))) break;
      put(activate({ ...j, steps: j.steps.map((x) => (x.n === id ? { ...x, status: "dropped", closedAt: at, reason: String(d.reason ?? "").slice(0, 200) } : x)) }, at, id ?? undefined));
      break;
    }
    case "JobClosed": if (j) { const o = str(d.outcome); close(o === "blocked" || o === "failed" || o === "dropped" ? o : "done", str(d.reason) ?? o ?? "closed"); } break;
    case "AgentGone": if (j) { const ph = n.reported?.phase; close(ph === "blocked" || ph === "failed" ? ph : openSteps(j).length ? "dropped" : "done", "despawn"); } break; // close-out: nothing stays open on a gone agent
    case "JobGraded": { const id = num(d.job); jobs = jobs.map((x) => (x.id === id ? { ...x, grade: num(d.grade), gradeNote: str(d.note) } : x)); break; }
  }
  if (!jobs.length) return;
  n.jobs = jobs; n.tasks = tasksOf(jobs.at(-1));
}
