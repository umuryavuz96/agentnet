// Adopt-workspace client: types of the section-4/6 payloads (docs/internal/SPEC-adopt-workspace.md), the fetchers for the
// panel routes of section 11, and the pure helpers the onboarding steps use (card order, default picks, diff parsing).
// The page never reads files: everything shown comes from the report and the plan the server carries.

export type Confidence = "high" | "medium" | "low";
export type Suggestion = "switch-off" | "adopt-as-souls" | "neutralise-lines" | "keep-as-is" | "manual";
export type Kind = "coordination-system" | "agent-definitions" | "workspace-instructions" | "identity-claim" | "hook" | "mcp-server" | "scheduled-runner" | "other";
export interface Evidence { signal: string; path: string; line?: number; quote?: string }
export type Action =
  | { id: string; op: "park-hook"; file: string; event: string; matcher?: string | null; commandIncludes: string }
  | { id: string; op: "park-mcp"; file: string; server: string }
  | { id: string; op: "disable-lines"; file: string; fromLine: number; toLine: number; why: string }
  | { id: string; op: "register-souls"; repo: string; name: string; source: "agent-def" | "claude-md"; defFile?: string }
  | { id: string; op: "manual"; title: string; command?: string; why: string };
export interface Finding {
  id: string; kind: Kind; title: string; about: string; confidence: Confidence; risk: "low" | "medium" | "high";
  agents: string[]; evidence: Evidence[]; suggestion: Suggestion; actions: Action[];
  /** Set by the server when an action targets ~/.claude (the card shows the red badge). */
  global?: boolean;
}
export interface AdoptReport { version: 1; scanId: string; workspace: string; scanner: "director" | "static"; summary: string; findings: Finding[]; more?: number }

export interface PlanOp {
  id?: string; op: string; file?: string; global?: boolean; beforeSha?: string; afterSha?: string; diff?: string;
  fromActions?: string[]; findingId?: string; create?: string[]; preview?: string;
}
export interface AdoptPlan { planId: string; workspace: string; ops: PlanOp[]; willBackup: string[]; backupDir: string; rollbackCommand: string; warnings: string[] }
export type Phase = "idle" | "scanning" | "reported" | "planned" | "applying" | "applied" | "rolledback";
export interface AdoptRun { runId: string; at: number; workspace: string; files: number; state: "applied" | "rolledback" }
/** Scan progress shown in step 3: `facts` is set once the collector is done; `failed` carries the reason when the director did not report. */
export interface AdoptState {
  phase: Phase; mode: "clean" | "adopt" | null; workspace: string | null; scanId: string | null; planId: string | null; runId: string | null;
  scanner?: "director" | "static" | null; facts?: { signals: number } | null; failed?: string | null;
  report: AdoptReport | null; plan: AdoptPlan | null; runs: AdoptRun[];
}
export interface Precheck { instructions: boolean; claudeDir: boolean; repos: number; agentDefs: number; tmuxAgents: number }

/** What the owner chose on the cards: per finding apply/skip, plus per-action opt-outs inside a card (the soul checklist). */
export interface Picks { findings: Record<string, "apply" | "skip">; skipActions: string[] }

// ---------- helpers ----------
const ORDER: Record<Kind, number> = { "coordination-system": 0, "identity-claim": 1, hook: 2, "mcp-server": 2, "workspace-instructions": 3, "agent-definitions": 4, "scheduled-runner": 5, other: 6 };
/** Card order of section 7.4; `keep-as-is` and `manual` are split off by `groupFindings`. */
export function sortFindings(fs: Finding[]): Finding[] {
  return [...fs].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.id.localeCompare(b.id, "en", { numeric: true }));
}
export function groupFindings(fs: Finding[]) {
  const s = sortFindings(fs);
  return {
    cards: s.filter((f) => f.suggestion !== "keep-as-is" && f.suggestion !== "manual"),
    manual: s.filter((f) => f.suggestion === "manual"),
    fine: s.filter((f) => f.suggestion === "keep-as-is"),
  };
}
/** Section 4.2 defaults: switch-off only for high confidence, souls on, neutralise off, low confidence starts on Skip. */
export function defaultPicks(fs: Finding[]): Picks {
  const findings: Picks["findings"] = {};
  for (const f of fs) {
    if (f.suggestion === "keep-as-is" || f.suggestion === "manual") continue;
    const on = f.suggestion === "adopt-as-souls" ? true : f.suggestion === "switch-off" ? f.confidence === "high" : false;
    findings[f.id] = on && f.confidence !== "low" ? "apply" : "skip";
  }
  return { findings, skipActions: [] };
}
/** Files the plan would change, for the "Preview changes (N files)" button: the unique files of the applied, non-manual actions. */
export function pickedFiles(fs: Finding[], p: Picks): string[] {
  const set = new Set<string>();
  for (const f of fs) {
    if (p.findings[f.id] !== "apply") continue;
    for (const a of f.actions) if (a.op === "park-hook" || a.op === "park-mcp" || a.op === "disable-lines") set.add(a.file);
  }
  return [...set];
}
export const hasPicks = (fs: Finding[], p: Picks) => fs.some((f) => p.findings[f.id] === "apply" && f.actions.some((a) => a.op !== "manual" && !p.skipActions.includes(a.id)));
export const soulName = (a: Action) => (a.op === "register-souls" ? a.name : "");
export const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
/** Path relative to the workspace when it lives inside it (".claude/settings.json"); anything else (a global file) stays absolute so it is never mistaken for a local one. */
export function shortPath(p: string, base?: string) { return base && p.startsWith(base + "/") ? p.slice(base.length + 1) : p; }

export interface DiffLine { t: "add" | "del" | "ctx" | "hunk" | "meta"; s: string }
/** Parse a unified diff into typed lines (the preview colours them; the header lines +++/--- are `meta`). */
export function parseDiff(diff: string | undefined): DiffLine[] {
  if (!diff) return [];
  return diff.replace(/\n$/, "").split("\n").map((s) => {
    if (s.startsWith("+++") || s.startsWith("---")) return { t: "meta", s };
    if (s.startsWith("@@")) return { t: "hunk", s };
    if (s.startsWith("+")) return { t: "add", s };
    if (s.startsWith("-")) return { t: "del", s };
    return { t: "ctx", s };
  });
}
export function diffStat(diff: string | undefined) {
  let add = 0, del = 0;
  for (const l of parseDiff(diff)) { if (l.t === "add") add++; else if (l.t === "del") del++; }
  return { add, del };
}
/** The one-line label per changed file in the preview: "-1 hook", "lines 3-5" ... derived from the ops, never invented. */
export function opLabel(o: PlanOp, f?: Finding[]): string {
  const acts = (f ?? []).flatMap((x) => x.actions).filter((a) => o.fromActions?.includes(a.id));
  const a = acts[0];
  if (a?.op === "park-hook") return acts.length > 1 ? `-${acts.length} hooks` : "-1 hook";
  if (a?.op === "park-mcp") return acts.length > 1 ? `-${acts.length} servers` : "-1 server";
  if (a?.op === "disable-lines") return acts.map((x) => (x.op === "disable-lines" ? (x.fromLine === x.toLine ? `line ${x.fromLine}` : `lines ${x.fromLine}-${x.toLine}`) : "")).join(", ");
  const { add, del } = diffStat(o.diff);
  return `+${add} -${del}`;
}
/** Ops that edit an existing file. Created files (director prompt, souls) belong under "New files", never in the diff list. */
export const changedOps = (p: AdoptPlan) => p.ops.filter((o) => o.file && o.op !== "register-souls" && o.op !== "write-director-prompt");
/** Summary line of the preview: "3 files change, 6 files are created, 3 files are backed up first." */
export function planSummary(p: AdoptPlan) {
  const changed = changedOps(p);
  const created = p.ops.reduce((n, o) => n + (o.create?.length ?? 0), 0);
  const w = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return `${w(changed.length, "file changes", "files change")}, ${w(created, "file is created", "files are created")}, ${w(p.willBackup.length, "file is", "files are")} backed up first.`;
}
export const planHasGlobal = (p: AdoptPlan) => p.ops.some((o) => o.global);
/** A card whose action edits a file outside the workspace under a .claude folder (the user's global settings): red badge plus a confirm box. */
export function isGlobal(f: Finding, workspace: string): boolean {
  return !!f.global || f.actions.some((a) => "file" in a && !a.file.startsWith(workspace + "/") && /\/\.claude\//.test(a.file));
}
