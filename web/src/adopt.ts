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
  /** ids of findings whose actions switch this one off (the "system" card: nothing left to do by hand once those are applied) */
  parkedBy?: string[];
}
export interface AdoptReport { version: 1; scanId: string; workspace: string; scanner: "director" | "static"; summary: string; findings: Finding[]; more?: number }

export interface PlanOp {
  id?: string; op: string; file?: string; global?: boolean; beforeSha?: string; afterSha?: string; diff?: string;
  fromActions?: string[]; findingId?: string; create?: string[]; preview?: string;
}
export interface AdoptPlan { planId: string; workspace: string; ops: PlanOp[]; willBackup: string[]; backupDir: string; rollbackCommand: string; warnings: string[] }
export type Phase = "idle" | "scanning" | "reported" | "planned" | "applying" | "applied" | "rolledback";
export interface AdoptRun { runId: string; createdAt: string; workspace: string; files: number; state: "applied" | "rolledback" }
/** Scan progress shown in step 3: `facts` is set once the collector is done; `failed` carries the reason when the director did not report. */
export interface AdoptState {
  phase: Phase; mode: "clean" | "adopt" | null; workspace: string | null; scanId: string | null; planId: string | null; runId: string | null;
  scanner?: "director" | "static" | null; facts?: { signals: number } | null; failed?: string | null;
  report: AdoptReport | null; plan: AdoptPlan | null; runs: AdoptRun[];
}
export interface Launch { state: "idle" | "starting" | "waiting" | "connected" | "failed"; startedAt?: number; deadlineAt?: number; stage?: "session" | "claude" | "trust" | "hello"; error?: string; sessionName?: string; pane?: string | null; exitCode?: number | null; hint?: string; dialog?: { kind: "trust" | "mcp" | "mcp-multi" | "pane"; title: string; options: { id: string; label: string; selected: boolean }[]; servers?: { name: string; checked: boolean; enable: boolean }[] } | null }
export interface Precheck { instructions: boolean; claudeDir: boolean; repos: number; agentDefs: number; tmuxAgents: number }

/** What the owner chose on the cards: per finding apply/skip, plus per-action opt-outs inside a card (the soul checklist). */
export interface Picks { findings: Record<string, "apply" | "skip">; skipActions: string[] }

// ---------- helpers ----------
const ORDER: Record<Kind, number> = { "coordination-system": 0, "identity-claim": 1, hook: 2, "mcp-server": 2, "workspace-instructions": 3, "agent-definitions": 4, "scheduled-runner": 5, other: 6 };
/** Card order of section 7.4; `keep-as-is` and `manual` are split off by `groupFindings`. */
export function sortFindings(fs: Finding[]): Finding[] {
  return [...fs].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.id.localeCompare(b.id, "en", { numeric: true }));
}
/** A card with nothing to click: its parts are switched off by other cards (`parkedBy`), or it simply keeps running. */
const isSystem = (f: Finding) => (f.suggestion === "keep-as-is" || f.suggestion === "manual") && !!f.parkedBy?.length && !f.actions.some((a) => a.op === "manual");
export function groupFindings(fs: Finding[]) {
  const s = sortFindings(fs);
  return {
    cards: s.filter((f) => f.suggestion !== "keep-as-is" && f.suggestion !== "manual"),
    system: s.filter(isSystem),
    manual: s.filter((f) => f.suggestion === "manual" && !isSystem(f)),
    fine: s.filter((f) => f.suggestion === "keep-as-is" && !isSystem(f)),
  };
}
/** True when every finding that parks this one is applied (and has an action left on). */
export const parkedNow = (f: Finding, fs: Finding[], p: Picks) =>
  !!f.parkedBy?.length && f.parkedBy.every((id) => { const g = fs.find((x) => x.id === id); return !!g && p.findings[id] === "apply" && (() => { const as = g.actions.filter((a) => a.op !== "manual"); return as.length > 0 && as.every((a) => !p.skipActions.includes(a.id)); })(); });

export interface ParkGroup { key: string; label: string; global: boolean; actions: (Action & { op: "park-hook" | "park-mcp" })[] }
/** The hooks and MCP servers of a switch-off card, grouped by where they live: one group per repo, one for the user's own files. Actions keep their own ids, so a group checkbox is just a set of per-action opt-outs. */
export function parkGroups(f: Finding, base = ""): ParkGroup[] {
  const m = new Map<string, ParkGroup>();
  for (const a of f.actions) {
    if (a.op !== "park-hook" && a.op !== "park-mcp") continue;
    const repo = /^(.*)\/\.claude\/settings(?:\.local)?\.json$/.exec(a.file)?.[1] ?? (/^(.*)\/\.mcp\.json$/.exec(a.file)?.[1] ?? null);
    const global = repo === null || /^\/(?:Users|home)\/[^/]+$/.test(repo) || repo === "/root";
    const key = global ? "~" : repo!;
    const label = global ? "Your own Claude Code settings" : repo === base ? baseName(repo) + " (this folder)" : baseName(repo!);
    const g = m.get(key) ?? { key, label, global, actions: [] };
    g.actions.push(a as ParkGroup["actions"][number]); m.set(key, g);
  }
  return [...m.values()].sort((a, b) => Number(a.global) - Number(b.global) || a.label.localeCompare(b.label));
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

// ---------- "what changes" and "after adopt" (derived from the report and the picks; a server `change` / `after` wins when present) ----------
export interface AfterItem { kind: string; label: string; file?: string; findingId?: string }
export interface AfterAgent { name: string; role: string; source: string }
/** Optional server-built structure (report.after). Every field is optional: the page derives what is missing. */
export interface AfterServer { director?: { name: string; model?: string }; agents?: AfterAgent[]; stay?: AfterItem[]; off?: AfterItem[]; messaging?: string }
export interface Change { before: string; after: string }

const act = (f: Finding, o: Action["op"]) => f.actions.filter((a) => a.op === o);
/** Plain before/after for one card. Words come from the finding's own title and actions; nothing about the files is invented. */
export function changeOf(f: Finding & { change?: Change }, base?: string): Change {
  if (f.change?.before && f.change.after) return f.change;
  const sp = (p: string) => shortPath(p, base);
  if (f.suggestion === "adopt-as-souls") {
    const n = act(f, "register-souls").length;
    return { before: `${n} ${n === 1 ? "agent is" : "agents are"} defined in your repo files and only that repo's sessions know ${n === 1 ? "it" : "them"}.`, after: `${n === 1 ? "It becomes" : "They become"} workspace ${n === 1 ? "soul" : "souls"}: the director can start ${n === 1 ? "it" : "them"} as ${n === 1 ? "an agentnet agent" : "agentnet agents"}. Your files stay as they are.` };
  }
  if (f.suggestion === "switch-off") {
    const hooks = act(f, "park-hook"), mcps = act(f, "park-mcp"), lines = act(f, "disable-lines");
    const what = [hooks.length ? `${hooks.length} ${hooks.length === 1 ? "hook" : "hooks"}` : "", mcps.length ? `${mcps.length} MCP ${mcps.length === 1 ? "server" : "servers"}` : "", lines.length ? `${lines.length} ${lines.length === 1 ? "block" : "blocks"} of instructions` : ""].filter(Boolean).join(" and ") || "this setup";
    const files = [...new Set(f.actions.flatMap((a) => ("file" in a ? [sp(a.file)] : [])))];
    const one = !what.includes(" and ") && what.startsWith("1 ");
    return { before: `${f.title}: ${what} run${one ? "s" : ""} next to agentnet${files.length ? ` (${files.join(", ")})` : ""}.`, after: `Switched off. ${what[0].toUpperCase() + what.slice(1)} ${one ? "is" : "are"} parked, not deleted, and the backup can bring ${one ? "it" : "them"} back. agentnet is the only way agents talk.` };
  }
  if (f.suggestion === "neutralise-lines") {
    const l = act(f, "disable-lines");
    return { before: `${l.length || "Some"} ${l.length === 1 ? "line tells" : "lines tell"} agents to use another name or another way to report.`, after: "Those lines are commented out. Agents use their agentnet name and agentnet messages. The rest of the file is untouched." };
  }
  if (f.suggestion === "keep-as-is") return { before: f.about, after: "Nothing changes." };
  return { before: f.about, after: "agentnet changes nothing here. You do this step by hand." };
}

export interface AfterView { director: { name: string; model?: string }; agents: AfterAgent[]; stay: AfterItem[]; off: AfterItem[]; messaging: string; instructions: string[] }
/** The picture after adopt, live from the picks: who the team is, what keeps running, what is parked. */
export function afterAdopt(r: AdoptReport & { after?: AfterServer }, picks: Picks, base?: string): AfterView {
  const s = r.after ?? {}, applied = (f: Finding) => picks.findings[f.id] === "apply";
  const agents: AfterAgent[] = [...(s.agents ?? [])], off: AfterItem[] = [], stay: AfterItem[] = [...(s.stay ?? [])];
  const item = (f: Finding, a?: Action): AfterItem => ({ kind: f.kind, label: f.title, file: a && "file" in a ? shortPath(a.file, base) : undefined, findingId: f.id });
  for (const f of r.findings) {
    if (f.suggestion === "adopt-as-souls") {
      if (!s.agents && applied(f)) for (const a of act(f, "register-souls")) if (a.op === "register-souls" && !picks.skipActions.includes(a.id)) agents.push({ name: a.name, role: "workspace soul", source: a.defFile ? shortPath(a.defFile, base) : "CLAUDE.md" });
    } else if (f.suggestion === "switch-off" || f.suggestion === "neutralise-lines") {
      if (applied(f)) { if (!s.off) off.push(item(f, f.actions.find((x) => x.op !== "manual" && x.op !== "register-souls"))); }
      else if (!r.after?.stay) stay.push(item(f, f.actions.find((a) => "file" in a)));
    } else if (f.suggestion === "keep-as-is" && !r.after?.stay) stay.push(item(f));
  }
  const offAll = s.off ?? off;
  const coord = r.findings.some((f) => f.kind === "coordination-system" && applied(f));
  const coordLeft = r.findings.some((f) => f.kind === "coordination-system" && !applied(f) && f.suggestion !== "keep-as-is");
  return {
    director: s.director ?? { name: "root" }, agents, stay, off: offAll,
    messaging: (s.messaging && s.messaging.includes(" ") ? s.messaging : "") || (coordLeft ? "agentnet messages, but another message system still runs next to it. Two systems on the same agents can clash." : coord ? "agentnet messages only. Your old message system is switched off." : "agentnet messages. Nothing else coordinates your agents."),
    instructions: ["Your CLAUDE.md and rules still load.", "agentnet adds one block on top: the director is root, coordination goes through agentnet, repo rules win on project matters."],
  };
}

// ---------- the After adopt panel: sections of plain rows, hooks grouped by repo ----------
export interface AfterRow { name: string; where?: string; full?: string; note?: string }
export interface AfterGroup { key: string; label: string; global: boolean; rows: AfterRow[] }
export interface AfterPlan { director: { name: string; model?: string }; agents: AfterAgent[]; off: AfterGroup[]; offCount: number; stay: AfterGroup[]; stayCount: number; messaging: string; notes: string[] }

/** "check-inbox.sh" out of "$CLAUDE_PROJECT_DIR/bin/check-inbox.sh --quiet". Empty when the command was hidden by the redaction. */
export function scriptName(cmd: string): string {
  const t = cmd.split(/\s+/).filter(Boolean).find((x) => /[\w.-]\.[a-z0-9]{1,4}$/i.test(x) && !x.includes("***")) ?? cmd.split(/\s+/).filter(Boolean).pop() ?? "";
  const b = baseName(t);
  return /\*\*\*/.test(b) ? "" : b;
}
/** Plain name of a hook: "Stop hook: runs check-inbox.sh". A command hidden by the secret redaction gets a readable label instead of "***". */
export function hookRow(event: string, cmd: string): Pick<AfterRow, "name" | "note"> {
  const s = scriptName(cmd);
  return s ? { name: `${event} hook: runs ${s}` } : { name: `${event} hook`, note: "Command hidden: it contains a secret" };
}
const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
/** Shorten the middle of a long path, keep the start and the file name: "~/projects/…/bin/check-inbox.sh". */
export function midEllipsis(p: string, max = 40): string {
  if (p.length <= max) return p;
  const parts = p.split("/"), last = parts[parts.length - 1], first = parts.slice(0, 2).join("/");
  const tail = last.length > max - 8 ? last.slice(0, max - 9) + "…" : last;
  return `${first}/…/${tail}`.length <= max + 2 ? `${first}/…/${tail}` : "…/" + tail;
}

export function afterPlan(r: AdoptReport & { after?: AfterServer }, picks: Picks, base?: string): AfterPlan {
  const s = r.after ?? {}, applied = (f: Finding) => picks.findings[f.id] === "apply";
  const off = new Map<string, AfterGroup>(), stay = new Map<string, AfterGroup>();
  const put = (m: Map<string, AfterGroup>, key: string, label: string, global: boolean, row: AfterRow) => { const g = m.get(key) ?? { key, label, global, rows: [] }; g.rows.push(row); m.set(key, g); };
  const agents: AfterAgent[] = [...(s.agents ?? [])];
  for (const f of r.findings) {
    if (f.suggestion === "adopt-as-souls") {
      if (!s.agents && applied(f)) for (const a of f.actions) if (a.op === "register-souls" && !picks.skipActions.includes(a.id)) agents.push({ name: a.name, role: "workspace soul", source: a.defFile ? shortPath(a.defFile, base) : "CLAUDE.md" });
      continue;
    }
    for (const g of parkGroups(f, base)) for (const a of g.actions) {
      const rel = g.global ? tilde(a.file) : a.file.slice(g.key.length + 1);
      const row: AfterRow = a.op === "park-hook" ? { ...hookRow(a.event, a.commandIncludes), where: rel, full: tilde(a.file) } : { name: `MCP server: ${a.server}`, where: rel, full: tilde(a.file) };
      const on = applied(f) && !picks.skipActions.includes(a.id);
      put(on ? off : stay, g.key, g.label, g.global, row);
    }
    for (const a of f.actions) if (a.op === "disable-lines") {
      const row: AfterRow = { name: `${baseName(a.file)} ${a.fromLine === a.toLine ? "line " + a.fromLine : "lines " + a.fromLine + "-" + a.toLine}`, where: shortPath(a.file, base), full: tilde(a.file) };
      const on = applied(f) && !picks.skipActions.includes(a.id);
      put(on ? off : stay, "instr", "Instruction lines", false, row);
    }
    if (f.parkedBy?.length && !f.actions.some((x) => x.op === "manual")) put(parkedNow(f, r.findings, picks) ? off : stay, "system", "Old message system", false, { name: f.title, note: parkedNow(f, r.findings, picks) ? "Nothing left that loads" : "Keeps running beside agentnet" });
  }
  // things the scan saw but proposed no action for, as the server lists them (hooks and MCP servers that stay; CLAUDE.md files that still load)
  const loads = (s.stay ?? []).filter((x) => x.kind === "instructions").length;
  for (const x of s.stay ?? []) if (x.kind !== "instructions") put(stay, "seen", "Seen, not touched", false, { name: x.label, where: x.file, full: x.file });
  const count = (m: Map<string, AfterGroup>) => [...m.values()].filter((g) => g.key !== "system").reduce((n, g) => n + g.rows.length, 0); // the message-system line is a status, not a file
  const order = (m: Map<string, AfterGroup>) => [...m.values()].sort((a, b) => Number(a.global) - Number(b.global) || a.label.localeCompare(b.label));
  const coordLeft = r.findings.some((f) => f.kind === "coordination-system" && !applied(f) && f.suggestion !== "keep-as-is") || [...stay.values()].some((g) => g.key !== "system" && g.key !== "instr");
  const anyOff = count(off) > 0;
  return {
    director: s.director ?? { name: "root" }, agents, off: order(off), offCount: count(off), stay: order(stay), stayCount: count(stay),
    messaging: (s.messaging && s.messaging.includes(" ") ? s.messaging : "") || (coordLeft ? "agentnet messages, but another message system still runs next to it. Two systems on the same agents can clash." : anyOff ? "agentnet messages only. Your old message system is switched off." : "agentnet messages. Nothing else coordinates your agents."),
    notes: [loads ? `Your CLAUDE.md files still load (${loads}).` : "Your CLAUDE.md and rules still load.", "agentnet adds one block on top: the director is root, repo rules win on project matters."],
  };
}
