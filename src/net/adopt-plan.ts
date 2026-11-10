// Plan and diff for "adopt an existing workspace". buildPlan turns the user's picks on a validated report into a closed list of ops,
// recomputing every change from the file now on disk (the director's text is never executed). It has no side effects.
// computeChanges is shared with adopt-apply.ts so apply writes exactly what the preview showed.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { allowedRead, sha256Text } from "./adopt-safe";
import { ROOT } from "../core/config";
import { soulBody, wsCatalog, wsDir } from "./workspace";
import type { Action, AdoptReport, Finding } from "./adopt-report";

export interface Picks { findings: Record<string, "apply" | "skip">; /** per-action opt-out inside an applied finding (the souls checklist) */ actions?: Record<string, boolean> }
export interface PlanCtx { runId: string; /** $AGENTNET_HOME, default ROOT */ root?: string; /** workspace souls folder, default wsDir() */ workspaceDir?: string }

export type OpDesc =
  | { op: "park-hook"; file: string; event: string; matcher: string | null; commandIncludes: string }
  | { op: "park-mcp"; file: string; server: string }
  | { op: "disable-lines"; file: string; fromLine: number; toLine: number }
  | { op: "register-souls"; repo: string; name: string; source: "agent-def" | "claude-md"; defFile?: string; roleClash?: boolean }
  | { op: "write-director-prompt"; file: string };
export type PlanOp = OpDesc & {
  id: string; global: boolean; fromActions: string[]; findingId: string | null;
  /** file ops: sha of the text before / after this op (the first op of a file starts at the sha on disk) */
  beforeSha?: string; afterSha?: string; diff?: string;
  /** register-souls / write-director-prompt: what gets created */
  create?: string[]; preview?: string; replaces?: boolean;
};
export interface Plan {
  planId: string; workspace: string; scanId: string; runId: string; ops: PlanOp[];
  /** one entry per changed file: sha on disk now and sha after all ops */
  files: { file: string; beforeSha: string; afterSha: string; global: boolean }[];
  willBackup: string[]; create: string[]; backupDir: string; rollbackCommand: string;
  needsConfirmGlobal: boolean; warnings: string[];
}
/** What a change of one file looks like before it is written. `parked` holds the removed hook / MCP entry (env and header values blanked). */
export interface FileChange { file: string; beforeText: string; afterText: string; beforeSha: string; afterSha: string; steps: { opIndex: number; beforeSha: string; afterSha: string; diff: string; parked?: Parked }[] }
export interface Parked { file: string; kind: "hook" | "mcp"; event?: string; matcher?: string | null; server?: string; entry: unknown }
/** The plan id: a hash over the ops (without the diff text), the file shas and the run id. apply recomputes it to prove the plan object was not edited. */
export const planIdFor = (p: Pick<Plan, "workspace" | "scanId" | "runId" | "ops" | "files">): string =>
  "plan-" + sha256Text(JSON.stringify({ workspace: p.workspace, scanId: p.scanId, runId: p.runId, ops: p.ops.map(({ diff: _d, preview: _p, ...rest }) => rest), files: p.files })).slice(0, 16);
export type PlanResult = { ok: true; plan: Plan } | { ok: false; errors: string[] };

/** Where the composed adopt-mode director prompt lives. Same path as director.ts promptPath("adopt"); duplicated so plan and rollback do not pull in the server modules (a test keeps them equal). */
export const directorPromptFile = (root: string): string => join(root, "run", "souls", "agentnet-director.md");
const home = () => process.env.HOME ?? homedir();
const isGlobal = (f: string) => f === join(home(), ".claude.json") || f === join(home(), ".claude") || f.startsWith(join(home(), ".claude") + "/");
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

// ---------- unified diff ----------
/** Unified diff of two texts with 3 lines of context. Trims the common head and tail, then a line LCS on the middle (whole-block replace when huge). */
export function unifiedDiff(a: string, b: string, labelA = "a", labelB = "b"): string {
  if (a === b) return "";
  const A = a.split("\n"), B = b.split("\n");
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const ma = A.slice(pre, A.length - suf), mb = B.slice(pre, B.length - suf);
  type Line = { t: " " | "-" | "+"; s: string };
  const mid: Line[] = [];
  if (ma.length * mb.length > 4_000_000) { ma.forEach((s) => mid.push({ t: "-", s })); mb.forEach((s) => mid.push({ t: "+", s })); }
  else {
    const n = ma.length, m = mb.length, L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = ma[i] === mb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) { if (ma[i] === mb[j]) { mid.push({ t: " ", s: ma[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) mid.push({ t: "-", s: ma[i++] }); else mid.push({ t: "+", s: mb[j++] }); }
    while (i < n) mid.push({ t: "-", s: ma[i++] }); while (j < m) mid.push({ t: "+", s: mb[j++] });
  }
  const all: Line[] = [...A.slice(0, pre).map((s) => ({ t: " " as const, s })), ...mid, ...A.slice(A.length - suf).map((s) => ({ t: " " as const, s }))];
  const CTX = 3, out: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
  const changed = all.map((l, i) => (l.t === " " ? -1 : i)).filter((i) => i >= 0);
  let k = 0;
  while (k < changed.length) {
    let from = Math.max(0, changed[k] - CTX), to = Math.min(all.length - 1, changed[k] + CTX);
    while (k + 1 < changed.length && changed[k + 1] - CTX <= to + 1) { k++; to = Math.min(all.length - 1, changed[k] + CTX); }
    k++;
    const seg = all.slice(from, to + 1);
    const aStart = all.slice(0, from).filter((l) => l.t !== "+").length + 1, bStart = all.slice(0, from).filter((l) => l.t !== "-").length + 1;
    const aLen = seg.filter((l) => l.t !== "+").length, bLen = seg.filter((l) => l.t !== "-").length;
    out.push(`@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`);
    for (const l of seg) out.push(l.t + l.s);
  }
  return out.join("\n") + "\n";
}

// ---------- ops on text ----------
const blank = (v: unknown, key = ""): unknown => {
  if (Array.isArray(v)) return v.map((x) => blank(x));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(env|headers)$/i.test(k) && isObj(x) ? Object.fromEntries(Object.keys(x).map((e) => [e, "***"])) : blank(x, k)]));
  return /key|token|secret|passw/i.test(key) && typeof v === "string" ? "***" : v;
};
const dumpJson = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const without = (o: Obj, k: string) => { const c = { ...o }; delete c[k]; return JSON.stringify(c); };

export const stub = (from: number, to: number, runId: string) => `<!-- agentnet: lines ${from}-${to} switched off by run ${runId}; original in backup -->`;

/** Apply one file op to text. Throws Error with a readable message when the target is missing, ambiguous or the change would touch more than intended. */
export function applyOpText(text: string, d: OpDesc, runId: string): { text: string; parked?: Parked } {
  if (d.op === "disable-lines") {
    const lines = text.split("\n");
    if (d.fromLine < 1 || d.toLine < d.fromLine || d.toLine > lines.length) throw new Error(`${d.file}: lines ${d.fromLine}-${d.toLine} are outside the file`);
    lines.splice(d.fromLine - 1, d.toLine - d.fromLine + 1, stub(d.fromLine, d.toLine, runId));
    return { text: lines.join("\n") };
  }
  if (d.op === "park-hook") {
    const j = JSON.parse(text) as Obj;
    const hooks = j.hooks;
    const groups = isObj(hooks) ? hooks[d.event] : undefined;
    if (!Array.isArray(groups)) throw new Error(`${d.file}: no ${d.event} hooks`);
    const hits: { g: Obj; h: number }[] = [];
    for (const g of groups) if (isObj(g) && (g.matcher ?? null) === d.matcher && Array.isArray(g.hooks)) g.hooks.forEach((h, i) => { if (isObj(h) && typeof h.command === "string" && h.command.includes(d.commandIncludes)) hits.push({ g, h: i }); });
    if (hits.length !== 1) throw new Error(`${d.file}: ${hits.length} hooks match "${d.commandIncludes}" on ${d.event}, expected exactly 1`);
    const { g, h } = hits[0];
    const entry = blank((g.hooks as unknown[])[h]);
    (g.hooks as unknown[]).splice(h, 1);
    const hk = hooks as Obj;
    if (!(g.hooks as unknown[]).length) { const gi = (groups as unknown[]).indexOf(g); (groups as unknown[]).splice(gi, 1); if (!(groups as unknown[]).length) delete hk[d.event]; }
    return { text: dumpJson(j), parked: { file: d.file, kind: "hook", event: d.event, matcher: d.matcher, entry } };
  }
  if (d.op === "park-mcp") {
    const j = JSON.parse(text) as Obj;
    const holders: Obj[] = [];
    if (isObj(j.mcpServers) && Object.prototype.hasOwnProperty.call(j.mcpServers, d.server)) holders.push(j.mcpServers);
    if (isObj(j.projects)) for (const p of Object.values(j.projects)) if (isObj(p) && isObj(p.mcpServers) && Object.prototype.hasOwnProperty.call(p.mcpServers, d.server)) holders.push(p.mcpServers);
    if (holders.length !== 1) throw new Error(`${d.file}: ${holders.length} MCP servers named "${d.server}", expected exactly 1`);
    const entry = blank(holders[0][d.server]);
    delete holders[0][d.server];
    return { text: dumpJson(j), parked: { file: d.file, kind: "mcp", server: d.server, entry } };
  }
  throw new Error("not a file op");
}

/** Compute the real change of every file the descriptors touch, from the files on disk now. Throws Error on the first problem. */
export function computeChanges(descs: OpDesc[], runId: string): FileChange[] {
  const by = new Map<string, number[]>();
  descs.forEach((d, i) => { if ("file" in d && d.op !== "write-director-prompt") (by.get(d.file) ?? by.set(d.file, []).get(d.file)!).push(i); });
  const out: FileChange[] = [];
  for (const [file, idx] of by) {
    if (!existsSync(file)) throw new Error(`${file}: file does not exist`);
    const original = readFileSync(file, "utf8");
    // line edits go last-line-first so earlier numbers stay valid; ranges must not overlap
    const lineOps = idx.filter((i) => descs[i].op === "disable-lines").sort((a, b) => (descs[b] as { fromLine: number }).fromLine - (descs[a] as { fromLine: number }).fromLine);
    for (let k = 1; k < lineOps.length; k++) if ((descs[lineOps[k - 1]] as { fromLine: number }).fromLine <= (descs[lineOps[k]] as { toLine: number }).toLine) throw new Error(`${file}: line ranges overlap`);
    const order = [...idx.filter((i) => descs[i].op !== "disable-lines"), ...lineOps];
    let cur = original; const steps: FileChange["steps"] = [];
    for (const i of order) {
      const before = cur;
      const r = applyOpText(before, descs[i], runId);
      if (descs[i].op !== "disable-lines") {
        const a = JSON.parse(before) as Obj, b = JSON.parse(r.text) as Obj;
        const key = descs[i].op === "park-hook" ? "hooks" : null;
        if (key && without(a, key) !== without(b, key)) throw new Error(`${file}: change would touch more than the ${key} key`);
        if (!key) { const strip = (o: Obj) => { const c = JSON.parse(JSON.stringify(o)) as Obj; delete c.mcpServers; if (isObj(c.projects)) for (const p of Object.values(c.projects)) if (isObj(p)) delete p.mcpServers; return JSON.stringify(c); }; if (strip(a) !== strip(b)) throw new Error(`${file}: change would touch more than mcpServers`); }
      }
      cur = r.text;
      steps.push({ opIndex: i, beforeSha: sha256Text(before), afterSha: sha256Text(cur), diff: unifiedDiff(before, cur, `a${file}`, `b${file}`), parked: r.parked });
    }
    out.push({ file, beforeText: original, afterText: cur, beforeSha: sha256Text(original), afterSha: sha256Text(cur), steps });
  }
  return out;
}

// ---------- plan ----------
function selected(report: AdoptReport, picks: Picks, errors: string[]): { f: Finding; a: Action }[] {
  const ids = new Set(report.findings.map((f) => f.id));
  for (const id of Object.keys(picks.findings)) if (!ids.has(id)) errors.push(`picks.findings.${id}: no such finding`);
  const aids = new Set(report.findings.flatMap((f) => f.actions.map((a) => a.id)));
  for (const id of Object.keys(picks.actions ?? {})) if (!aids.has(id)) errors.push(`picks.actions.${id}: no such action`);
  const out: { f: Finding; a: Action }[] = [];
  for (const f of report.findings) if (picks.findings[f.id] === "apply") for (const a of f.actions) if (a.op !== "manual" && picks.actions?.[a.id] !== false) out.push({ f, a });
  return out;
}

export function buildPlan(report: AdoptReport, picks: Picks, ctx: PlanCtx): PlanResult {
  const errors: string[] = [];
  const root = ctx.root ?? ROOT, wsd = ctx.workspaceDir ?? wsDir();
  const sel = selected(report, picks, errors);
  const readRoots = [report.workspace, join(home(), ".claude"), join(home(), ".claude.json")];
  const descs: OpDesc[] = [], meta: { actions: string[]; finding: string | null }[] = [];
  const seen = new Map<string, number>();
  const add = (d: OpDesc, a: string | null, f: string | null) => {
    const key = JSON.stringify(d);
    const at = seen.get(key);
    if (at !== undefined) { if (a) meta[at].actions.push(a); return; }
    seen.set(key, descs.length); descs.push(d); meta.push({ actions: a ? [a] : [], finding: f });
  };
  for (const { f, a } of sel) {
    if (a.op === "park-hook") add({ op: a.op, file: a.file, event: a.event, matcher: a.matcher ?? null, commandIncludes: a.commandIncludes }, a.id, f.id);
    else if (a.op === "park-mcp") add({ op: a.op, file: a.file, server: a.server }, a.id, f.id);
    else if (a.op === "disable-lines") add({ op: a.op, file: a.file, fromLine: a.fromLine, toLine: a.toLine }, a.id, f.id);
    else if (a.op === "register-souls") add({ op: a.op, repo: a.repo, name: a.name, source: a.source, ...(a.defFile ? { defFile: a.defFile } : {}), ...(a.roleClash ? { roleClash: true } : {}) }, a.id, f.id);
  }
  for (const d of descs) if ("file" in d && !allowedRead(d.file, readRoots)) errors.push(`${d.file}: not a file the plan may change`);
  const dirPrompt = directorPromptFile(root);
  add({ op: "write-director-prompt", file: dirPrompt }, null, null);
  if (errors.length) return { ok: false, errors };

  let changes: FileChange[];
  try { changes = computeChanges(descs, ctx.runId); } catch (e) { return { ok: false, errors: [(e as Error).message] }; }
  const stepOf = new Map<number, FileChange["steps"][number]>();
  for (const c of changes) for (const s of c.steps) stepOf.set(s.opIndex, s);

  const warnings: string[] = [];
  const ops: PlanOp[] = descs.map((d, i) => {
    const base = { id: `o${i + 1}`, global: "file" in d && d.op !== "write-director-prompt" ? isGlobal(d.file) : false, fromActions: meta[i].actions, findingId: meta[i].finding };
    const s = stepOf.get(i);
    if (s) return { ...d, ...base, beforeSha: s.beforeSha, afterSha: s.afterSha, diff: s.diff } as PlanOp;
    if (d.op === "register-souls") {
      const soulFile = join(wsd, "souls", `${d.name}.md`);
      let defText: string | undefined; try { if (d.defFile) defText = readFileSync(d.defFile, "utf8"); } catch { /* reported at apply */ }
      const replaces = wsCatalog(wsd).some((e) => e.id === `ws/${d.name}`);
      if (replaces) warnings.push(`Replaces the existing workspace soul ws/${d.name}`);
      if (d.roleClash) warnings.push(`${d.name} is also a built-in role: the soul is added but not mapped to the role`);
      return { ...d, ...base, create: [soulFile], replaces, preview: soulBody({ repo: d.repo, name: d.name, source: d.source, defFile: d.defFile }, defText).split("\n").slice(0, 12).join("\n") } as PlanOp;
    }
    return { ...d, ...base, create: [dirPrompt], replaces: existsSync(dirPrompt) } as PlanOp;
  });
  const globalFiles = changes.filter((c) => isGlobal(c.file)).map((c) => c.file);
  for (const g of globalFiles) warnings.push(`Global file included: ${g.replace(home(), "~")}`);
  const files = changes.map((c) => ({ file: c.file, beforeSha: c.beforeSha, afterSha: c.afterSha, global: isGlobal(c.file) }));
  const willBackup = [...changes.map((c) => c.file), ...(existsSync(dirPrompt) ? [dirPrompt] : [])];
  const create = ops.flatMap((o) => (o.create && !o.replaces ? o.create : []));
  const planId = planIdFor({ workspace: report.workspace, scanId: report.scanId, runId: ctx.runId, ops, files });
  return { ok: true, plan: { planId, workspace: report.workspace, scanId: report.scanId, runId: ctx.runId, ops, files, willBackup, create, backupDir: join(root, "adopt", ctx.runId), rollbackCommand: `agentnet adopt rollback ${ctx.runId}`, needsConfirmGlobal: globalFiles.length > 0, warnings } };
}

/** CLI `adopt plan --accept`: the picks for a report. "all" applies every finding. "recommended" skips high-risk findings and never rewrites instruction lines (decision 4: neutralising is a per-line opt-in, off by default). */
export function acceptPicks(findings: { id: string; risk: string; actions?: { id: string; op: string }[] }[], accept: "all" | "recommended"): Picks {
  const out: Picks = { findings: Object.fromEntries(findings.map((f) => [f.id, accept === "all" || f.risk !== "high" ? "apply" : "skip"])) };
  if (accept === "recommended") {
    const off = findings.flatMap((f) => (f.actions ?? []).filter((a) => a.op === "disable-lines").map((a) => [a.id, false] as const));
    if (off.length) out.actions = Object.fromEntries(off);
  }
  return out;
}
/** One-line label of a plan op for the CLI: the file, or the soul it registers. */
export function opLabel(o: { op: string; file?: string; name?: string; repo?: string; global?: boolean }): string {
  const what = o.file ?? (o.op === "register-souls" ? [o.name, o.repo && `(${o.repo})`].filter(Boolean).join(" ") : "");
  return `${what}${o.global ? " (global)" : ""}`;
}
