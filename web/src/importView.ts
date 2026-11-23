// Pure view logic of the import flow in the setup window (docs/internal/one-folder/SPEC-step5-import-ui.md).
// The server (src/net/agent-import.ts) owns the proposal, the plan and the run; this file only groups, counts, labels and folds
// SSE progress into op lines. No fetch here, so bun test covers it without a browser.

export type ItemKind = "instruction" | "rule" | "skill" | "agent-def" | "command" | "hook" | "settings-env" | "mcp" | "plugin" | "agent" | "team";
export interface ItemEdits { name?: string; model?: string | null; boss?: string | null; team?: string | null; director?: boolean; lead?: string | null; members?: string[] }
export interface ImportItem { id: string; kind: ItemKind; source: string; target: string; summary: string; reason: string; accept: boolean; badges: string[]; edits?: ItemEdits; standing?: 1 }
export interface Proposal { runId: string; items: ImportItem[] }
export type RunPhase = "idle" | "proposed" | "previewed" | "applying" | "applied" | "failed" | "rolledback" | "cancelled";
export interface ImportManifest { runId: string; files: { target: string }[]; dirs: string[]; agents: { name: string; id: string }[]; teams: string[]; souls: boolean; complete: boolean }
export interface ImportState { runId: string | null; phase: RunPhase; project?: string | null; items?: number; planId?: string | null; error?: string | null; errors?: string[]; manifest?: ImportManifest | null; plan?: ImportPlan | null }
export type PlanOp = { id: string; item: string | null; op: string; status?: "ok" | "failed" | "skipped"; error?: string; source?: string; target?: string; size?: number; name?: string;
  diff?: string; conflicts?: string[]; files?: { rel: string; size: number }[]; agent?: { name: string; director?: boolean }; team?: { id: string } };
export interface ImportPlan { planId: string; runId: string; ops: PlanOp[]; files: { target: string; size: number }[]; warnings: string[] }
export interface Progress { type: "import.progress"; runId: string; phase: string; op?: string; opId?: string; target?: string; status?: string; detail?: string; at: number }
export interface Rollback { ok: boolean; runId: string; removed: string[]; restored: string[]; kept: { file: string; why: string }[]; agents: string[]; teams: string[]; error?: string }

export const MODELS = ["haiku", "sonnet", "opus", "fable"] as const; // src/net/routing.ts MODELS
export const NAME_RE = /^[a-z0-9-]{1,32}$/;

// ---------- groups ----------
export type GroupKey = "staff" | "instructions" | "skills" | "hooks" | "settings" | "mcp" | "plugins";
export const GROUPS: { key: GroupKey; title: string; kinds: ItemKind[] }[] = [
  { key: "staff", title: "Agents and teams", kinds: ["agent", "team", "agent-def"] },
  { key: "instructions", title: "Instructions and rules", kinds: ["instruction", "rule"] },
  { key: "skills", title: "Skills and commands", kinds: ["skill", "command"] },
  { key: "hooks", title: "Hooks", kinds: ["hook"] },
  { key: "settings", title: "Settings", kinds: ["settings-env"] },
  { key: "mcp", title: "MCP servers", kinds: ["mcp"] },
  { key: "plugins", title: "Plugins", kinds: ["plugin"] },
];
const KIND_ORDER: ItemKind[] = ["team", "agent", "agent-def", "instruction", "rule", "skill", "command", "hook", "settings-env", "mcp", "plugin"];
export const groupOf = (k: ItemKind): GroupKey => GROUPS.find((g) => g.kinds.includes(k))!.key;
/** Plugins are a note only: they are not copied, so their switch changes nothing and they never count. */
export const toggleable = (i: Pick<ImportItem, "kind">) => i.kind !== "plugin";

export interface Group { key: GroupKey; title: string; rows: ImportItem[]; on: number; total: number }
/** Items by group in GROUPS order, kinds in a fixed order inside a group, then the server's order. Empty groups are left out. */
export function groupItems(items: ImportItem[], on: (i: ImportItem) => boolean): Group[] {
  return GROUPS.map((g) => {
    const rows = items.filter((i) => g.kinds.includes(i.kind)).map((i, k) => ({ i, k })).sort((a, b) => KIND_ORDER.indexOf(a.i.kind) - KIND_ORDER.indexOf(b.i.kind) || a.k - b.k).map((x) => x.i);
    const t = rows.filter(toggleable);
    return { key: g.key, title: g.title, rows, on: t.filter(on).length, total: t.length };
  }).filter((g) => g.rows.length);
}
/** "2 of 5 on"; a plugins-only group says it is manual. */
export const groupCount = (g: Pick<Group, "on" | "total">) => (g.total ? `${g.on} of ${g.total} on` : "install by hand");
/** The group switch: on when every switchable row is on. Pressing it turns all on, or all off when all were on. */
export const groupAllOn = (g: Group, on: (i: ImportItem) => boolean) => g.rows.filter(toggleable).every(on);
/** The footer number: switchable items that are on. */
export const footerCount = (items: ImportItem[], on: (i: ImportItem) => boolean) => items.filter((i) => toggleable(i) && on(i)).length;
export const footerLabel = (n: number) => `Preview ${n} ${n === 1 ? "item" : "items"}`;

// ---------- badges ----------
const BADGES: Record<string, string> = { "runs a script outside the folder": "Runs a script outside the folder", "holds a secret": "Holds a secret", project: "Project", manual: "Manual" };
/** Server badges in plain words, plus "Global" for items read from ~/.claude or ~/.claude.json of `home`. */
export function badgeLabels(i: Pick<ImportItem, "badges" | "source">, home?: string | null): { label: string; tone: "warn" | "info" }[] {
  const out = i.badges.map((b) => ({ label: BADGES[b] ?? b.charAt(0).toUpperCase() + b.slice(1), tone: (b === "project" || b === "manual" ? "info" : "warn") as "warn" | "info" }));
  if (home && (i.source.startsWith(home.replace(/\/$/, "") + "/.claude/") || i.source === home.replace(/\/$/, "") + "/.claude.json")) out.push({ label: "Global", tone: "info" });
  return out;
}
const TITLE: Record<ItemKind, string> = { instruction: "Instructions", rule: "Rule", skill: "Skill", "agent-def": "Agent definition", command: "Command", hook: "Hook", "settings-env": "Setting", mcp: "MCP server", plugin: "Plugin", agent: "Agent", team: "Team" };
export const kindTitle = (k: ItemKind) => TITLE[k];
export const KIND_ICON: Record<ItemKind, string> = { instruction: "file-text", rule: "file-text", skill: "sparkles", "agent-def": "user", command: "square-terminal", hook: "webhook", "settings-env": "sliders", mcp: "network", plugin: "layers", agent: "user", team: "users" };

// ---------- edits ----------
/** "" when the name is fine, else the reason in plain words. */
export function nameError(n: string): string {
  if (!n) return "Give it a name.";
  if (n.length > 32) return "At most 32 characters.";
  if (!NAME_RE.test(n)) return "Only lowercase letters, digits and dashes.";
  return "";
}
/** The server's decide errors are "<item id>: <message>"; the ones for this item, without the prefix. */
export const errorsFor = (errors: string[], id: string) => errors.filter((e) => e.startsWith(id + ": ")).map((e) => e.slice(id.length + 2));
/** Boss choices for an agent: root, the other accepted agents in the import, then live agents; never itself. */
export function bossOptions(self: string, importNames: string[], liveNames: string[]): string[] {
  const out = ["root"];
  for (const n of [...importNames, ...liveNames]) if (n && n !== self && !out.includes(n)) out.push(n);
  return out;
}

// ---------- preview ----------
const base = (p = "") => p.split("/").filter(Boolean).pop() ?? p;
export function opLabel(o: PlanOp): string {
  switch (o.op) {
    case "copy-file": return `Copy ${base(o.target)}`;
    case "copy-dir": return `Copy skill ${base(o.target)} (${o.files?.length ?? 0} ${o.files?.length === 1 ? "file" : "files"})`;
    case "rewrite-hook-path": return `Copy hook script ${base(o.target)} and point the hook at it`;
    case "register-soul": return `Register soul for ${o.name}`;
    case "write-base-settings": return "Write base settings.json";
    case "write-base-mcp": return "Write base mcp.json";
    case "mark-complete": return "Mark the base setup complete";
    case "create-team": return `Create team ${o.team?.id ?? ""}`;
    case "create-agent": return `Create agent ${o.agent?.name ?? ""} (standing)`;
    case "start-agent": return `Start ${o.name}`;
    default: return o.op;
  }
}
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
/** Ops that carry a diff the preview can unfold. */
export const hasDiff = (o: PlanOp) => !!o.diff;

// ---------- run ----------
export type LineStatus = "pending" | "running" | "done" | "failed" | "skipped";
export interface Line { id: string; label: string; status: LineStatus; error?: string }
/** One line per op, all pending. */
export const initLines = (plan: Pick<ImportPlan, "ops">): Line[] => plan.ops.map((o) => ({ id: o.id, label: opLabel(o), status: "pending" }));
/** Fold one SSE event into the lines. Only apply events of this run with an op id count; the first pending line after them is running. */
export function reduceLines(lines: Line[], e: Progress, runId: string, applying = true): Line[] {
  let next = lines;
  if (e.runId === runId && e.phase === "apply" && e.opId) {
    const st: LineStatus | null = e.status === "ok" ? "done" : e.status === "failed" ? "failed" : e.status === "skipped" ? "skipped" : null;
    if (st) next = lines.map((l) => (l.id === e.opId ? { ...l, status: st, ...(st === "failed" && e.detail ? { error: e.detail } : {}) } : l));
  }
  return markRunning(next, applying && !(e.runId === runId && e.phase === "apply" && !e.opId && e.status === "done"));
}
/** While applying, the first pending line is the one running now. */
export function markRunning(lines: Line[], applying: boolean): Line[] {
  const clean = lines.map((l) => (l.status === "running" ? { ...l, status: "pending" as LineStatus } : l));
  if (!applying || clean.some((l) => l.status === "failed" && clean.slice(clean.indexOf(l) + 1).every((x) => x.status !== "done"))) return clean;
  const k = clean.findIndex((l) => l.status === "pending");
  return k < 0 ? clean : clean.map((l, i) => (i === k ? { ...l, status: "running" } : l));
}
/** The lines from the plan after the run (status set by the server), for a reopened window. */
export const linesFromPlan = (plan: Pick<ImportPlan, "ops">): Line[] => plan.ops.map((o) => ({ id: o.id, label: opLabel(o), status: o.status === "ok" ? "done" : o.status === "failed" ? "failed" : o.status === "skipped" ? "skipped" : "pending", ...(o.error && o.status === "failed" ? { error: o.error } : {}) }));
/** What to show: every line up to and with the first failure; later skipped lines fold into one count. */
export function visibleLines(lines: Line[]): { shown: Line[]; notRun: number } {
  const shown = lines.filter((l) => l.status !== "skipped");
  return { shown, notRun: lines.length - shown.length };
}
/** "3 files copied, 1 agent created, 1 team created, 1 agent started" from the manifest and the line states. */
export function runSummary(m: Pick<ImportManifest, "files" | "teams">, plan: Pick<ImportPlan, "ops">, lines: Line[]): string {
  const ok = (op: string) => plan.ops.filter((o) => o.op === op && lines.find((l) => l.id === o.id)?.status === "done").length;
  const pl = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return `${pl(m.files.length, "file")} copied, ${pl(ok("create-agent"), "agent")} created, ${pl(m.teams.length, "team")} created, ${pl(ok("start-agent"), "agent")} started`;
}
/** True when an apply error means the sources moved under the preview: offer Rescan. */
export const isStale = (msg: string) => /changed since (the )?preview|plan changed|preview again/i.test(msg);
/** After an import: the director the import itself started (an agent item with edits.director), or null when the setup must start
 *  the clean director. A director op that failed counts as none, so the user can still start one. */
export function importedDirector(plan: Pick<ImportPlan, "ops"> | null | undefined, lines: Line[]): string | null {
  const d = plan?.ops.find((o) => o.op === "create-agent" && o.agent?.director);
  if (!d?.agent) return null;
  const start = plan!.ops.find((o) => o.op === "start-agent" && o.name === d.agent!.name);
  const st = start && (lines.find((l) => l.id === start.id)?.status ?? (start.status === "ok" ? "done" : undefined));
  return st === "done" ? d.agent.name : null;
}
export const needsDirector = (plan: Pick<ImportPlan, "ops"> | null | undefined, lines: Line[]) => importedDirector(plan, lines) === null;
