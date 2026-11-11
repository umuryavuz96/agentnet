// The director's report about a workspace is untrusted input. This file is its closed schema and the validator.
// Unknown keys are dropped; every path must pass the scan path policy; every claim must point at a signal the collector produced.
// The server never executes director-provided text: ops are re-derived from the files later (adopt-plan.ts).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { denyReason, redactText } from "./adopt-safe";
import { isLegacy } from "./adopt-legacy";
import type { Facts } from "./adopt-scan";

export const KINDS = ["coordination-system", "agent-definitions", "workspace-instructions", "identity-claim", "hook", "mcp-server", "scheduled-runner", "other"] as const;
export const SUGGESTIONS = ["switch-off", "adopt-as-souls", "neutralise-lines", "keep-as-is", "manual"] as const;
const LEVELS = ["high", "medium", "low"] as const;
const RISKS = ["low", "medium", "high"] as const;
export type Kind = (typeof KINDS)[number];
export type Suggestion = (typeof SUGGESTIONS)[number];

/** Stable hash of one line (trailing space ignored), so a block can be found again without storing the text. */
export const lineHash = (l: string): string => createHash("sha256").update(l.replace(/\s+$/, "")).digest("hex").slice(0, 12);
export interface Evidence { signal: string; path: string; line?: number; quote?: string }
export type Action =
  | { id: string; op: "park-hook"; file: string; event: string; matcher?: string | null; commandIncludes: string; legacy?: true }
  | { id: string; op: "park-mcp"; file: string; server: string; legacy?: true }
  /** expect = line hashes of the range at report time (see lineHash): apply re-finds the block when the file moved. legacy = set by the server when the lines mention the predecessor setup */
  | { id: string; op: "disable-lines"; file: string; fromLine: number; toLine: number; why: string; expect?: string[]; legacy?: true }
  | { id: string; op: "register-souls"; repo: string; name: string; source: "agent-def" | "claude-md"; defFile?: string; roleClash?: boolean }
  | { id: string; op: "manual"; title: string; command?: string; why: string };
export interface Finding {
  id: string; kind: Kind; title: string; about: string; confidence: (typeof LEVELS)[number]; risk: (typeof RISKS)[number];
  agents: string[]; evidence: Evidence[]; suggestion: Suggestion; actions: Action[];
  /** ids of other findings whose actions switch this one off: when they are applied the card reads "Parked by the actions above" instead of "do by hand" */
  parkedBy?: string[];
  /** set by the server: an action targets a file under ~/.claude, which affects every Claude Code session */
  global?: boolean;
}
export interface AdoptReport { version: 1; scanId: string; workspace: string; scanner: "director" | "static"; summary: string; findings: Finding[]; omitted?: number }

export const MAX_REPORT_BYTES = 64 * 1024;
export const MAX_FINDINGS = 40;
export const MAX_LINE_RANGE = 60;
/** Hooks in 7 repos are 14 settings files: one finding may carry this many actions. */
export const MAX_ACTIONS = 40;
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

export interface ValidateOpts { scanId?: string; scanner?: "director" | "static"; builtinRoles?: Iterable<string> }
export type ValidateResult = { ok: true; report: AdoptReport } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const home = () => process.env.HOME ?? homedir();
const isGlobal = (p: string) => { const h = home() + "/.claude"; return p === h || p.startsWith(h + "/") || p === home() + "/.claude.json"; };

export const defaultScanId = (f: Facts) => "scan-" + createHash("sha256").update(f.workspace + "\0" + f.scannedAt).digest("hex").slice(0, 8);

export function validateReport(raw: unknown, facts: Facts, opts: ValidateOpts = {}): ValidateResult {
  const errors: string[] = [];
  const err = (path: string, msg: string) => { errors.push(`${path}: ${msg}`); };
  if (!isObj(raw)) return { ok: false, errors: ["report: must be an object"] };
  try { if (Buffer.byteLength(JSON.stringify(raw)) > MAX_REPORT_BYTES) return { ok: false, errors: ["report: larger than 64 KB"] }; } catch { return { ok: false, errors: ["report: not JSON"] }; }

  // what the collector saw: refs, files named by signals, repos, instruction lines
  const refs = new Set(facts.signals.map((s) => s.ref));
  const named = new Set<string>();
  for (const s of facts.signals) for (const k of ["file", "scriptPath", "path"]) if (typeof s[k] === "string") named.add(s[k] as string);
  const roots = [...facts.roots, ...named];
  const repoMap = new Map(facts.repos.map((r) => [r.path, r]));
  const instrLines = new Map<string, Set<number>>();
  for (const s of facts.signals) {
    const f = s.file as string | undefined; if (!f) continue;
    if (s.id === "S-INSTR-MSG") for (const l of (s.lines as { line: number }[])) (instrLines.get(f) ?? instrLines.set(f, new Set()).get(f)!).add(l.line);
    if (s.id === "S-INSTR-IDENTITY") (instrLines.get(f) ?? instrLines.set(f, new Set()).get(f)!).add(s.line as number);
  }
  const defFiles = new Set(facts.signals.filter((s) => s.id === "S-REPO-AGENT-DEF" && !s.claudeMdOnly).map((s) => s.file as string));
  const builtin = new Set(opts.builtinRoles ?? []);

  const str = (p: string, v: unknown, max: number, min = 1): string | null => {
    if (typeof v !== "string") { err(p, "must be a string"); return null; }
    if (v.length < min) { err(p, "must not be empty"); return null; }
    if (v.length > max) { err(p, `longer than ${max} characters`); return null; }
    return v;
  };
  const oneOf = <T extends string>(p: string, v: unknown, list: readonly T[]): T | null => { if (typeof v === "string" && (list as readonly string[]).includes(v)) return v as T; err(p, `must be one of ${list.join(", ")}`); return null; };
  /** an absolute path that resolves inside the scan roots and passes the deny list (symlinks followed) */
  const pathOk = (p: string, v: unknown): string | null => {
    if (typeof v !== "string" || !isAbsolute(v)) { err(p, "must be an absolute path"); return null; }
    const abs = resolve(v);
    const why = denyReason(abs, roots);
    if (why) { err(p, why === "outside the scan roots" ? "outside scan roots" : why); return null; }
    return abs;
  };
  const readJson = (file: string): Obj | null => { try { const j = JSON.parse(readFileSync(file, "utf8")) as unknown; return isOb(j) ? j : null; } catch { return null; } };
  const isOb = isObj;

  const summary = str("summary", raw.summary, 400);
  if (!Array.isArray(raw.findings)) err("findings", "must be an array");
  const rawFindings = Array.isArray(raw.findings) ? raw.findings : [];

  const findings: Finding[] = [];
  const seenF = new Set<string>(), seenA = new Set<string>();
  rawFindings.forEach((rf, i) => {
    const fp = `findings[${i}]`;
    if (!isObj(rf)) { err(fp, "must be an object"); return; }
    const before = errors.length;
    const id = typeof rf.id === "string" && /^f[0-9]{1,3}$/.test(rf.id) ? rf.id : (err(`${fp}.id`, "must match f1..f999"), null);
    if (id && seenF.has(id)) err(`${fp}.id`, "duplicate id"); else if (id) seenF.add(id);
    const kind = oneOf(`${fp}.kind`, rf.kind, KINDS);
    const title = str(`${fp}.title`, rf.title, 80);
    const about = str(`${fp}.about`, rf.about, 400);
    const confidence = oneOf(`${fp}.confidence`, rf.confidence, LEVELS);
    let risk = oneOf(`${fp}.risk`, rf.risk, RISKS);
    const suggestion = oneOf(`${fp}.suggestion`, rf.suggestion, SUGGESTIONS);
    const agents: string[] = [];
    if (!Array.isArray(rf.agents) || rf.agents.length > 30) err(`${fp}.agents`, "must be an array of at most 30 names");
    else rf.agents.forEach((a, j) => { const n = typeof a === "string" ? a.toLowerCase() : ""; if (AGENT_NAME.test(n)) { if (!agents.includes(n)) agents.push(n); } else err(`${fp}.agents[${j}]`, "not a valid agent name"); });

    const evidence: Evidence[] = [];
    if (!Array.isArray(rf.evidence) || rf.evidence.length < 1 || rf.evidence.length > 8) err(`${fp}.evidence`, "needs 1 to 8 entries");
    else rf.evidence.forEach((e, j) => {
      const ep = `${fp}.evidence[${j}]`;
      if (!isObj(e)) { err(ep, "must be an object"); return; }
      const signal = typeof e.signal === "string" && refs.has(e.signal) ? e.signal : (err(`${ep}.signal`, "unknown signal ref"), null);
      const path = pathOk(`${ep}.path`, e.path);
      let line: number | undefined;
      if (e.line !== undefined) { if (Number.isInteger(e.line) && (e.line as number) >= 1) line = e.line as number; else err(`${ep}.line`, "must be a positive integer"); }
      let quote: string | undefined;
      if (e.quote !== undefined) { if (typeof e.quote === "string") quote = redactText(e.quote).slice(0, 160); else err(`${ep}.quote`, "must be a string"); }
      if (signal && path) evidence.push({ signal, path, ...(line !== undefined ? { line } : {}), ...(quote !== undefined ? { quote } : {}) });
    });

    const actions: Action[] = [];
    if (!Array.isArray(rf.actions) || rf.actions.length > MAX_ACTIONS) err(`${fp}.actions`, `must be an array of at most ${MAX_ACTIONS} actions`);
    else rf.actions.forEach((a, j) => {
      const ap = `${fp}.actions[${j}]`;
      if (!isObj(a)) { err(ap, "must be an object"); return; }
      const aid = typeof a.id === "string" && /^a[0-9]{1,3}$/.test(a.id) ? a.id : (err(`${ap}.id`, "must match a1..a999"), null);
      if (aid && seenA.has(aid)) err(`${ap}.id`, "duplicate id"); else if (aid) seenA.add(aid);
      const op = oneOf(`${ap}.op`, a.op, ["park-hook", "park-mcp", "disable-lines", "register-souls", "manual"] as const);
      if (!op || !aid) return;
      if (op === "park-hook") {
        const file = pathOk(`${ap}.file`, a.file);
        const event = str(`${ap}.event`, a.event, 40);
        const ci = str(`${ap}.commandIncludes`, a.commandIncludes, 200);
        let matcher: string | null | undefined;
        if (a.matcher !== undefined && a.matcher !== null) matcher = str(`${ap}.matcher`, a.matcher, 200) ?? undefined; else matcher = a.matcher as null | undefined;
        if (file && event && ci) {
          const j2 = readJson(file); const groups = isOb(j2?.hooks) ? (j2!.hooks as Obj)[event] : undefined;
          const hit = Array.isArray(groups) && groups.some((g) => isObj(g) && (g.matcher ?? null) === (matcher ?? null) && Array.isArray(g.hooks) && g.hooks.some((h) => isObj(h) && typeof h.command === "string" && h.command.includes(ci)));
          if (!hit) err(ap, "no such hook in that file");
          else actions.push({ id: aid, op, file, event, matcher: matcher ?? null, commandIncludes: ci });
        }
      } else if (op === "park-mcp") {
        const file = pathOk(`${ap}.file`, a.file);
        const server = str(`${ap}.server`, a.server, 100);
        if (file && server) {
          const j2 = readJson(file);
          const proj = isOb(j2?.projects) ? Object.values(j2!.projects as Obj).filter(isObj) : [];
          const sets = [j2?.mcpServers, ...proj.map((p) => p.mcpServers)];
          if (!sets.some((s) => isObj(s) && Object.prototype.hasOwnProperty.call(s, server))) err(ap, "no such MCP server in that file");
          else actions.push({ id: aid, op, file, server });
        }
      } else if (op === "disable-lines") {
        const file = pathOk(`${ap}.file`, a.file);
        const why = str(`${ap}.why`, a.why, 300);
        const from = a.fromLine, to = a.toLine;
        if (!Number.isInteger(from) || !Number.isInteger(to) || (from as number) < 1 || (to as number) < (from as number)) { err(ap, "fromLine/toLine must be integers with 1 <= fromLine <= toLine"); return; }
        if ((to as number) - (from as number) + 1 > MAX_LINE_RANGE) { err(ap, `range longer than ${MAX_LINE_RANGE} lines`); return; }
        if (file && why) {
          let n = 0; try { n = readFileSync(file, "utf8").split("\n").length; } catch { /* checked below */ }
          if (!n || (to as number) > n) { err(ap, "line range is outside the file"); return; }
          const sig = instrLines.get(file);
          let overlap = false; if (sig) for (const l of sig) if (l >= (from as number) && l <= (to as number)) { overlap = true; break; }
          if (!overlap) err(ap, "range does not contain any line the scan flagged");
          else actions.push({ id: aid, op, file, fromLine: from as number, toLine: to as number, why });
        }
      } else if (op === "register-souls") {
        const repo = pathOk(`${ap}.repo`, a.repo);
        const name = typeof a.name === "string" && AGENT_NAME.test(a.name.toLowerCase()) ? a.name.toLowerCase() : (err(`${ap}.name`, "not a valid agent name"), null);
        const source = oneOf(`${ap}.source`, a.source, ["agent-def", "claude-md"] as const);
        if (repo && !repoMap.has(repo)) err(`${ap}.repo`, "not a repo the scan found");
        let defFile: string | undefined;
        if (source === "agent-def") { const d = pathOk(`${ap}.defFile`, a.defFile); if (d && !defFiles.has(d)) err(`${ap}.defFile`, "not an agent definition the scan found"); else if (d) defFile = d; }
        if (source === "claude-md" && repo && repoMap.get(repo) && !repoMap.get(repo)!.hasClaudeMd) err(ap, "repo has no CLAUDE.md");
        if (repo && repoMap.has(repo) && name && source && (source === "claude-md" || defFile)) actions.push({ id: aid, op, repo, name, source, ...(defFile ? { defFile } : {}), ...(builtin.has(name) ? { roleClash: true } : {}) });
      } else {
        const title = str(`${ap}.title`, a.title, 120);
        const why = str(`${ap}.why`, a.why, 300);
        let command: string | undefined;
        if (a.command !== undefined) { const c = str(`${ap}.command`, a.command, 300); if (c) command = redactText(c); }
        if (title && why) actions.push({ id: aid, op, title, ...(command ? { command } : {}), why });
      }
    });
    if (suggestion && Array.isArray(rf.actions) && !rf.actions.length && suggestion !== "keep-as-is" && suggestion !== "manual") err(`${fp}.actions`, "empty only for keep-as-is and manual");

    let parkedBy: string[] | undefined;
    if (rf.parkedBy !== undefined) {
      if (Array.isArray(rf.parkedBy) && rf.parkedBy.length <= 6 && rf.parkedBy.every((x) => typeof x === "string" && /^f[0-9]{1,3}$/.test(x))) parkedBy = [...new Set(rf.parkedBy as string[])];
      else err(`${fp}.parkedBy`, "must be an array of up to 6 finding ids");
    }
    if (errors.length > before || !id || !kind || !title || !about || !confidence || !risk || !suggestion) return;
    const global = actions.some((a) => ("file" in a && isGlobal(a.file)));
    if (global && risk === "low") risk = "medium";
    findings.push({ id, kind, title, about, confidence, risk, agents, evidence, suggestion, actions, ...(parkedBy?.length ? { parkedBy } : {}), ...(global ? { global: true } : {}) });
  });

  // server-side tags: the line hashes (apply re-locates moved lines) and the predecessor leftovers (pre-selected in the plan)
  for (const f of findings) for (const a of f.actions) {
    if (a.op === "park-hook" && isLegacy(a.commandIncludes)) a.legacy = true;
    else if (a.op === "park-mcp") { const j = readJson(a.file); const sets = [j?.mcpServers, ...(isOb(j?.projects) ? Object.values(j!.projects as Obj).filter(isObj).map((p) => p.mcpServers) : [])]; if (isLegacy(a.server) || sets.some((s) => isObj(s) && isLegacy(JSON.stringify((s as Obj)[a.server] ?? "")))) a.legacy = true; }
    else if (a.op === "disable-lines") { try { const ls = readFileSync(a.file, "utf8").split("\n").slice(a.fromLine - 1, a.toLine); a.expect = ls.map(lineHash); if (ls.some((l) => isLegacy(l))) a.legacy = true; } catch { /* unreadable: no tags */ } }
  }
  for (const f of findings) if (f.parkedBy) { f.parkedBy = f.parkedBy.filter((x) => x !== f.id && seenF.has(x)); if (!f.parkedBy.length) delete f.parkedBy; }
  if (errors.length || summary === null) return { ok: false, errors: errors.length ? errors : ["summary: invalid"] };
  // keep the strongest findings when there are more than the UI shows
  const rank = (f: Finding) => (RISKS.length - 1 - RISKS.indexOf(f.risk)) * 3 + LEVELS.indexOf(f.confidence);
  const kept = findings.length > MAX_FINDINGS ? [...findings].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_FINDINGS) : findings;
  const report: AdoptReport = {
    version: 1, scanId: opts.scanId ?? defaultScanId(facts), workspace: facts.workspace, scanner: opts.scanner ?? "director",
    summary: summary!, findings: kept, ...(findings.length > MAX_FINDINGS ? { omitted: findings.length - MAX_FINDINGS } : {}),
  };
  return { ok: true, report };
}
