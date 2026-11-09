// Client side of the update sheet: a pure state machine plus a small Markdown reader for release notes.
// The component feeds it actions (server status, stream events, health polls, clock ticks) and renders `phase`.
// Nothing here touches the DOM, the network or the clock, so every state can be tested with a fake clock.

export type StepId = "preflight" | "checkout" | "install" | "build" | "swap" | "restart" | "health" | "doctor";
export interface Step { id: StepId; state: "pending" | "running" | "ok" | "failed" | "skipped"; detail?: string; ms?: number }
export interface JobResult {
  id: string; from: string; to: string;
  outcome: "updated" | "rolled-back" | "rollback-failed" | "refused" | "current";
  reason?: string; hint?: string; steps: Step[]; changelog?: string; manual?: string[];
}
export type UpdateEvent =
  | { t: number; type: "start"; id: string; from: string; to: string; source: string }
  | { t: number; type: "step"; step: Step }
  | { t: number; type: "log"; line: string }
  | { t: number; type: "done"; result: JobResult };

export interface Status {
  current: string; latest: string | null; available: boolean; checkedAt: number | null; published: string | null; notes: string; releaseUrl: string;
  checkEnabled: boolean; error?: string;
  web: { enabled: boolean; blocked: { code: string; hint: string } | null };
  mode: string; auto: { enabled: boolean; hour: number };
  job: (Partial<JobResult> & { id: string; running?: boolean; from: string; to: string; startedAt?: number; endedAt?: number }) | null;
}

export type Phase = "none" | "available" | "blocked" | "confirm" | "running" | "restarting" | "done" | "rolled-back" | "rollback-failed" | "refused" | "lost";

export const STEP_ORDER: StepId[] = ["preflight", "checkout", "install", "build", "swap", "restart", "health", "doctor"];
export const STEP_LABEL: Record<StepId, string> = {
  preflight: "Check the checkout", checkout: "Fetch the release", install: "Install packages", build: "Build the web app",
  swap: "Switch to the new build", restart: "Restart agentnet", health: "Wait for the new version", doctor: "Run the health checks",
};
/** Give up waiting for agentnet to come back after this long. */
export const LOST_MS = 90_000;
/** A finished job stays in the header pill this long. */
export const PILL_KEEP_MS = 10 * 60_000;

export interface Model {
  phase: Phase;
  status: Status | null;
  steps: Step[];
  log: string;
  from: string; to: string;
  result: JobResult | null;
  /** The job id the sheet follows. */
  jobId: string | null;
  /** Message of the last failed request (409, network); cleared by the next action. */
  error: string;
  /** Set while agentnet restarts: when we started waiting, and when the first health answer came. */
  waitSince: number | null;
  healthAt: number | null;
  /** The component should (re)open the progress stream. */
  reconnect: boolean;
  /** This page watched the job, so a finished job shows its result. */
  watched: boolean;
  /** Id of a finished job the user closed; status never brings it back. */
  dismissed: string | null;
}

const freshSteps = (): Step[] => STEP_ORDER.map((id) => ({ id, state: "pending" as const }));
export const initial = (): Model => ({ phase: "none", status: null, steps: freshSteps(), log: "", from: "", to: "", result: null, jobId: null, error: "", waitSince: null, healthAt: null, reconnect: false, watched: false, dismissed: null });

export type Action =
  | { type: "status"; status: Status; now: number }
  | { type: "ask" }
  | { type: "cancel" }
  | { type: "dismiss" }
  | { type: "started"; id: string }
  | { type: "failed"; message: string }
  | { type: "events"; events: UpdateEvent[]; now: number }
  | { type: "streamClosed"; now: number }
  | { type: "health"; ok: boolean; version?: string; now: number }
  | { type: "tick"; now: number };

const OUTCOME: Record<JobResult["outcome"], Phase> = { updated: "done", "rolled-back": "rolled-back", "rollback-failed": "rollback-failed", refused: "refused", current: "none" };
const LIVE: Phase[] = ["running", "restarting", "lost"];

/** Where the sheet starts when there is no live job: blocked, available or nothing. */
function idlePhase(s: Status | null): Phase {
  if (!s || !s.available) return "none";
  return !s.web.enabled || s.web.blocked ? "blocked" : "available";
}

function finish(m: Model, r: JobResult): Model {
  const steps = STEP_ORDER.map((id) => r.steps.find((x) => x.id === id) ?? { id, state: "pending" as const });
  return { ...m, phase: OUTCOME[r.outcome], result: r, steps, from: r.from, to: r.to, jobId: r.id, waitSince: null, healthAt: null, reconnect: false, error: "" };
}

function applyEvent(m: Model, e: UpdateEvent): Model {
  if (e.type === "start") return { ...m, jobId: e.id, from: e.from, to: e.to, steps: freshSteps(), log: "", result: null };
  if (e.type === "log") return { ...m, log: e.line };
  if (e.type === "step") {
    const steps = m.steps.map((s) => (s.id === e.step.id ? e.step : s));
    return { ...m, steps };
  }
  return finish(m, e.result);
}

export function reduce(m: Model, a: Action): Model {
  switch (a.type) {
    case "status": {
      const s = a.status, j = s.job;
      const base = { ...m, status: s, error: "" };
      if (LIVE.includes(m.phase) || m.phase === "confirm") return base; // a live sheet is driven by the stream
      if (j?.running) return { ...base, phase: "running", jobId: j.id, from: j.from, to: j.to, watched: true, reconnect: true, steps: freshSteps(), log: "" };
      // A release newer than the one the last job went for beats its result: the pill goes back to "Update vX".
      const newer = s.available && !!s.latest && `v${s.latest}` !== j?.to;
      if (j && j.outcome && !newer && j.id !== m.dismissed && j.endedAt !== undefined && a.now / 1000 - j.endedAt < PILL_KEEP_MS / 1000 && j.outcome !== "current") {
        const r = { id: j.id, from: j.from, to: j.to, outcome: j.outcome, reason: j.reason, hint: j.hint, steps: j.steps ?? [], changelog: j.changelog, manual: j.manual } as JobResult;
        return { ...finish(base, r), watched: true };
      }
      return { ...base, phase: idlePhase(s), result: null };
    }
    case "ask": return m.phase === "available" ? { ...m, phase: "confirm", error: "" } : m;
    case "cancel": return m.phase === "confirm" ? { ...m, phase: idlePhase(m.status), error: "" } : m;
    case "started": return { ...m, phase: "running", jobId: a.id, steps: freshSteps(), log: "", result: null, from: m.status?.current ? `v${m.status.current}` : m.from, to: m.status?.latest ? `v${m.status.latest}` : m.to, error: "", watched: true, reconnect: true, waitSince: null, healthAt: null };
    case "dismiss": return m.result ? { ...m, dismissed: m.result.id, phase: idlePhase(m.status), result: null, error: "", steps: freshSteps(), log: "", reconnect: false } : m;
    case "failed": return { ...m, error: a.message, phase: m.phase === "confirm" ? idlePhase(m.status) : m.phase };
    case "events": {
      let n: Model = { ...m, reconnect: false };
      // After a restart the page may be on the old phase: any event from the stream means agentnet answers again.
      for (const e of a.events) n = applyEvent(n, e);
      if (n.phase === "restarting" || n.phase === "lost") n = { ...n, phase: "running", waitSince: null, healthAt: null };
      return n;
    }
    case "streamClosed": {
      if (m.phase !== "running") return m;
      // The old server can die before the "restart running" event reaches the page, so swap=ok already counts as late.
      const late = m.steps.some((s) => (s.id === "swap" && s.state === "ok") || ((s.id === "restart" || s.id === "health") && s.state !== "pending"));
      // Closed before the swap: a network blip, reconnect at once. Closed after it: wait for agentnet to answer.
      return late ? { ...m, phase: "restarting", waitSince: a.now, healthAt: null, reconnect: false } : { ...m, reconnect: true };
    }
    case "health": {
      if (m.phase !== "restarting" && m.phase !== "lost") return m;
      if (!a.ok) return m;
      return { ...m, phase: "restarting", healthAt: m.healthAt ?? a.now, reconnect: true };
    }
    case "tick": {
      if (m.phase !== "restarting" || m.waitSince === null) return m;
      const from = m.healthAt ?? m.waitSince;
      return a.now - from >= LOST_MS ? { ...m, phase: "lost", reconnect: false } : m;
    }
  }
}

/** Header pill: text and kind, or null when nothing should show. */
export function pill(m: Model, now: number): { text: string; kind: "update" | "busy" | "bad" | "ok" } | null {
  if (m.phase === "running" || m.phase === "restarting") return { text: "Updating…", kind: "busy" };
  if (m.phase === "lost" || m.phase === "rolled-back" || m.phase === "rollback-failed") return { text: m.phase === "rolled-back" ? "Update rolled back" : "Update needs a look", kind: "bad" };
  if (m.phase === "done") return { text: `Updated to ${m.to}`, kind: "ok" };
  if (m.phase === "refused") return null;
  const s = m.status;
  if (s?.available && s.latest && (m.phase === "available" || m.phase === "blocked" || m.phase === "confirm")) return { text: `Update v${s.latest}`, kind: "update" };
  void now;
  return null;
}

// ---- release notes: a small Markdown reader (headings, bullets, bold, inline code, https links). Output is data, never HTML. ----
export type Inline = { kind: "text" | "b" | "em" | "code" | "a"; text: string; href?: string };
export type NoteBlock = { kind: "h" | "li" | "p"; level?: number; inline: Inline[] };

export function inline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)|(?<![\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])|(?<![\w_])_([^_\s](?:[^_]*[^_\s])?)_(?![\w_])/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ kind: "text", text: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "b", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "code", text: m[2] });
    else if (m[5] !== undefined || m[6] !== undefined) out.push({ kind: "em", text: (m[5] ?? m[6])! });
    else out.push({ kind: "a", text: m[3]!, href: m[4]! });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ kind: "text", text: src.slice(last) });
  return out;
}

export function notes(md: string): NoteBlock[] {
  const out: NoteBlock[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) out.push({ kind: "p", inline: inline(para.join(" ")) }); para = []; };
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(line), li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (h) { flush(); out.push({ kind: "h", level: h[1]!.length, inline: inline(h[2]!) }); }
    else if (li) { flush(); out.push({ kind: "li", inline: inline(li[1]!) }); }
    else if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return out;
}
