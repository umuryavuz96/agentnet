// Step 8a: self-improving agent lines (docs/internal/one-folder/SPEC-step8-lines.md, job 8a).
// A line is an agent name; its generations are the agent rows' gen. A line's self lives in lines/<line>/self/v<N>/ (soul, rules,
// lessons, skills); line.json says which version is current. Each generation proposes one upgrade (a rule with a machine check),
// the plugin hooks post proof when the check matches, and at the done report the despawn handler keeps or reverts the upgrade
// from reward and adherence. Root's later grade re-runs that decision. Only the server writes here; AGENTNET_LINES=1 turns the
// gates and the boot section on (off by default). Nothing here changes model weights: everything happens in context.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../core/config";
import { db } from "../core/db";
import { logEvent } from "../core/logger";
import { assertInHome } from "../core/paths";
import { redact } from "../core/redact";
import { soulsDir } from "../core/layout";
import { personaOf } from "./arsenal";
import { projectDir, transcriptFor } from "./feed";
import { median, roleOf } from "./score";
import { jobScoreRow, scoreDb } from "./scores";
import { get } from "./store";
import { setNoteReward } from "./trails";

export const linesOn = () => process.env.AGENTNET_LINES === "1";

// ---------- the store ----------
export type LineStatus = "active" | "probation" | "retired";
export interface LineEvent { at: number; from: LineStatus; to: LineStatus; reason: string }
export interface LineJson {
  current: number; baseline: number | null; status: LineStatus; parent: string | null; role: string; created: number;
  /** Step 8b life cycle: the fork source's version, the settled jobs below the role median in a row (on probation: since it began),
   *  the closed_at of the last job the life cycle looked at, and the last 20 state changes. */
  parentVersion?: number; below?: number; lifeAt?: number; history?: LineEvent[];
}
const LINE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const linesDir = (root = ROOT) => join(root, "lines");
export const lineDir = (line: string, root = ROOT) => { if (!LINE_RE.test(line)) throw new Error(`bad line name: ${line}`); return join(linesDir(root), line); };
export const selfDir = (line: string, v: number, root = ROOT) => join(lineDir(line, root), "self", `v${v}`);
const lineFile = (line: string) => join(lineDir(line), "line.json");
export function readLine(line: string): LineJson | null {
  try { const j = JSON.parse(readFileSync(lineFile(line), "utf8")) as LineJson; return j && Number.isInteger(j.current) ? j : null; } catch { return null; }
}
export function writeLine(line: string, j: LineJson) {
  const f = lineFile(line); assertInHome(f, "line.json");
  mkdirSync(lineDir(line), { recursive: true, mode: 0o700 });
  writeFileSync(`${f}.tmp`, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 }); renameSync(`${f}.tmp`, f);
}
const put = (f: string, text: string) => { assertInHome(f, "line self"); writeFileSync(f, text, { mode: 0o600 }); };
const readText = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
/** The soul text of a spawn: the arsenal persona of `soul`, else the soul file an earlier spawn of the name wrote, else empty. */
export function soulText(name: string, soul: string | null | undefined): string {
  try { const p = soul ? personaOf(soul) : null; if (p) return p.body; } catch { /* no catalog */ }
  return readText(join(soulsDir(), `agentnet-${name}.md`));
}
/** Create the line with v1 (the soul, empty rules and lessons) when it has none. Returns true when it was created. */
export function ensureLine(name: string, soul: string, now = Date.now()): boolean {
  if (readLine(name)) return false;
  const v1 = selfDir(name, 1); assertInHome(v1, "line self");
  mkdirSync(join(v1, "skills"), { recursive: true, mode: 0o700 });
  put(join(v1, "soul.md"), soul); put(join(v1, "rules.md"), ""); put(join(v1, "lessons.md"), "");
  writeLine(name, { current: 1, baseline: null, status: "active", parent: null, role: roleOf(name), created: now });
  return true;
}
const readSelf = (line: string, v: number, f: "rules.md" | "lessons.md" | "soul.md") => readText(join(selfDir(line, v), f));
const appendSelf = (line: string, v: number, f: "rules.md" | "lessons.md", l: string) => { const p = join(selfDir(line, v), f), t = readText(p); put(p, `${t}${t && !t.endsWith("\n") ? "\n" : ""}${l}\n`); };

// ---------- picks ----------
/** One `picks` row per decision of a spawn. Picking is manual for now, so every row has probability 1. Never throws. */
export function recordPicks(i: { name: string; model?: string | null; soul?: string | null; audit?: string | null }, now = Date.now()) {
  try {
    const role = roleOf(i.name), ctx = JSON.stringify(i.audit ? { audit: i.audit } : {});
    const row = (kind: string, chosen: string | null) => scoreDb().run("INSERT INTO picks (ts, kind, role, context_json, candidates_json, chosen, prob) VALUES (?, ?, ?, ?, ?, ?, 1)", [now, kind, role, ctx, JSON.stringify(chosen == null ? [] : [chosen]), chosen]);
    row("line", i.name); row("model", i.model ?? null); row("soul", i.soul ?? null);
  } catch (e) { logEvent("warn", "picks record failed", { agent: i.name, error: (e as Error).message }); }
}
/** createAgent's hook: the picks rows, and the line v1 on the name's first spawn. Never throws: a spawn never fails on a line. */
export function onSpawn(i: { name: string; model?: string | null; soul?: string | null; audit?: string | null }, now = Date.now()) {
  recordPicks(i, now);
  try { ensureLine(i.name, soulText(i.name, i.soul), now); } catch (e) { logEvent("warn", "line create failed", { agent: i.name, error: (e as Error).message }); }
}
/** `agentnet lines import`: a line per distinct agent name, v1 from its newest row's soul. Dry run unless apply. */
export function importLines(apply: boolean, now = Date.now()): { name: string; soul: string | null; exists: boolean }[] {
  const rows = db().query("SELECT name, soul FROM agents a WHERE gen = (SELECT MAX(gen) FROM agents b WHERE b.name = a.name) ORDER BY name").all() as { name: string; soul: string | null }[];
  const out = rows.filter((r) => LINE_RE.test(r.name)).map((r) => ({ name: r.name, soul: r.soul, exists: !!readLine(r.name) }));
  if (apply) for (const r of out) if (!r.exists) ensureLine(r.name, soulText(r.name, r.soul), now);
  return out;
}

// ---------- Thompson pick (step 8b) ----------
/** Every line on disk with its line.json, by name. */
export function allLines(): { line: string; json: LineJson }[] {
  let names: string[] = []; try { names = readdirSync(linesDir()).filter((n) => LINE_RE.test(n)).sort(); } catch { return []; }
  return names.flatMap((line) => { const json = readLine(line); return json ? [{ line, json }] : []; });
}
export const PICK_WINDOW = 20, PICK_MIN_JOBS = 5, PICK_MC = 2000;
/** A line's settled job rewards, oldest first, the last `n`: one per graded job of the line's agents (rewardOf over job_scores).
 *  A settled upgrade's line_versions.reward is the same rewardOf over the same row, so jobs with and without an upgrade count alike. */
export function lineRewards(line: string, n = PICK_WINDOW): number[] {
  const rows = scoreDb().query("SELECT grade, provisional, verified, done, rework FROM job_scores WHERE agent = ? AND grade IS NOT NULL ORDER BY closed_at DESC, id DESC LIMIT ?").all(line, n) as { grade: number; provisional: number; verified: number; done: number; rework: number }[];
  return rows.reverse().map((r) => rewardOf(r));
}
type Rng = () => number;
const normal = (rng: Rng) => { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };
/** Gamma(shape >= 1, 1), Marsaglia-Tsang. */
function gamma(k: number, rng: Rng): number {
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
/** One Beta(a, b) draw, a and b >= 1. */
export const betaDraw = (a: number, b: number, rng: Rng) => { const x = gamma(a, rng), y = gamma(b, rng); return x / (x + y); };
export interface Candidate { line: string; n: number; mean: number | null; status: LineStatus; /** Its share of the 2000 draws (not on the fallback). */ p?: number }
export type LinePick = { line: string; prob: number; candidates: Candidate[]; pick: number } | { fallback: "rubric"; candidates: Candidate[]; pick: number };
/** Pick a line of `role` by Thompson sampling over its settled rewards (scaled 0..1): Beta(1 + sum r, 1 + sum (1 - r)), the highest
 *  draw wins. Its probability of winning is estimated by 2000 more draws with the same rng. Until some candidate has 5 settled jobs
 *  the answer is the rubric fallback. Every call writes one `picks` row (kind line), prob null on the fallback. */
export function pickLine(role: string, rng: Rng = Math.random, now = Date.now()): LinePick {
  const lines = allLines().filter((l) => l.json.role === role && (l.json.status === "active" || l.json.status === "probation"));
  const rs = new Map(lines.map((l) => [l.line, lineRewards(l.line).map((r) => Math.max(0, Math.min(1, r / 5)))]));
  const candidates: Candidate[] = lines.map((l) => { const r = rs.get(l.line)!; return { line: l.line, n: r.length, mean: r.length ? Math.round((r.reduce((a, b) => a + b, 0) / r.length) * 1000) / 1000 : null, status: l.json.status }; });
  const log = (chosen: string | null, prob: number | null) => Number(scoreDb().run("INSERT INTO picks (ts, kind, role, context_json, candidates_json, chosen, prob) VALUES (?, 'line', ?, ?, ?, ?, ?)", [now, role, JSON.stringify({ by: "thompson", window: PICK_WINDOW }), JSON.stringify(candidates.map(({ line, n, mean, p }) => ({ line, n, mean, ...(p != null ? { p } : {}) }))), chosen, prob]).lastInsertRowid);
  if (!candidates.some((c) => c.n >= PICK_MIN_JOBS)) return { fallback: "rubric", candidates, pick: log(null, null) };
  const ab = candidates.map((c) => { const r = rs.get(c.line)!, s = r.reduce((a, b) => a + b, 0); return [1 + s, 1 + r.length - s] as const; });
  const draw = () => { let best = 0, top = -1; ab.forEach(([a, b], i) => { const x = betaDraw(a, b, rng); if (x > top) { top = x; best = i; } }); return best; };
  const chosen = draw(), wins = candidates.map(() => 0);
  for (let i = 0; i < PICK_MC; i++) wins[draw()]!++;
  candidates.forEach((c, i) => { c.p = Math.round((wins[i]! / PICK_MC) * 10000) / 10000; });
  const prob = candidates[chosen]!.p!, line = candidates[chosen]!.line;
  const out: LinePick = { line, prob, candidates, pick: log(line, prob) };
  for (const c of candidates) pickRetire(c.line, now); // 10 picks under 5% retires the line
  return out;
}
export const picksOf = (line: string, limit = 50) => scoreDb().query("SELECT * FROM picks WHERE kind = 'line' AND chosen = ? ORDER BY id DESC LIMIT ?").all(line, limit) as { id: number; ts: number; kind: string; role: string; context_json: string | null; candidates_json: string | null; chosen: string | null; prob: number | null }[];

// ---------- life cycle (step 8b) ----------
export const LIFE_PROBATION_AFTER = 3, LIFE_RETIRE_AFTER = 2, LIFE_PICKS = 10, LIFE_PICK_P = 0.05;
/** Where state changes are told (registerLineHandlers points it at root's inbox). */
let tell: (text: string) => void = () => {};
export const setLineTell = (fn: (text: string) => void) => { tell = fn; };
/** One message to root (proposals.ts and the life cycle). */
export const tellRoot = (text: string) => tell(text);
const setStatus = (line: string, lj: LineJson, to: LineStatus, reason: string, now: number) => {
  const from = lj.status; if (from === to) return;
  lj.status = to; lj.below = 0; lj.history = [...(lj.history ?? []), { at: now, from, to, reason }].slice(-20);
  logEvent("info", "line status", { line, from, to, reason });
};
/** The role's lines' last 20 graded job rewards, newest first, across every line of the role. */
export function roleRewards(role: string, n = PICK_WINDOW): number[] {
  const names = allLines().filter((l) => l.json.role === role).map((l) => l.line); if (!names.length) return [];
  const rows = scoreDb().query(`SELECT grade, provisional, verified, done, rework FROM job_scores WHERE agent IN (${names.map(() => "?").join(",")}) AND grade IS NOT NULL ORDER BY closed_at DESC, id DESC LIMIT ?`).all(...names, n) as { grade: number; provisional: number; verified: number; done: number; rework: number }[];
  return rows.map((r) => rewardOf(r));
}
/** The next free `<role>-<n>` (line folders and agent names both count). */
export function nextLineName(role: string): string {
  const re = new RegExp(`^${role.replace(/[^a-z0-9-]/g, "")}-(\\d+)$`);
  const used = [...allLines().map((l) => l.line), ...(db().query("SELECT DISTINCT name FROM agents").all() as { name: string }[]).map((r) => r.name)];
  return `${role}-${Math.max(0, ...used.map((x) => Number(re.exec(x)?.[1] ?? 0))) + 1}`;
}
/** Copy `from`'s current self into a new line `as` (v1, parent set). Throws when `as` exists or is not a line name. */
export function forkLine(from: string, as?: string, now = Date.now()): { line: string; parent: string; parentVersion: number } {
  const src = readLine(from); if (!src) throw new Error(`no line ${from}`);
  const name = as ?? nextLineName(src.role); if (readLine(name)) throw new Error(`line ${name} exists`);
  const dst = selfDir(name, 1); assertInHome(dst, "line self");
  mkdirSync(dirname(dst), { recursive: true, mode: 0o700 }); cpSync(selfDir(from, src.current), dst, { recursive: true });
  mkdirSync(join(dst, "skills"), { recursive: true, mode: 0o700 });
  writeLine(name, { current: 1, baseline: null, status: "active", parent: from, parentVersion: src.current, role: src.role, created: now, history: [{ at: now, from: "active", to: "active", reason: `forked from ${from} v${src.current}` }] });
  logEvent("info", "line forked", { line: name, from, version: src.current });
  return { line: name, parent: from, parentVersion: src.current };
}
/** The role's best line to fork: the highest EWMA of rewards among active lines with at least 5 settled jobs. */
export function bestLine(role: string, except?: string): string | null {
  let best: string | null = null, top = -1;
  for (const l of allLines()) {
    if (l.line === except || l.json.role !== role || l.json.status !== "active") continue;
    const r = lineRewards(l.line); if (r.length < PICK_MIN_JOBS) continue;
    const e = ewma(r)!; if (e > top) { top = e; best = l.line; }
  }
  return best;
}
/** Retire a line and fork the role's best line in its place. Never touches an agent row: a live agent keeps working, only picks stop. */
export function retireLine(line: string, reason: string, now = Date.now(), fork = true): { retired: boolean; forked: string | null; from: string | null } {
  const lj = readLine(line); if (!lj) throw new Error(`no line ${line}`);
  if (lj.status === "retired") return { retired: false, forked: null, from: null };
  setStatus(line, lj, "retired", reason, now); writeLine(line, lj);
  let forked: string | null = null, from: string | null = null;
  if (fork) {
    from = bestLine(lj.role, line);
    if (from) forked = forkLine(from, undefined, now).line; else logEvent("info", "line retired, no line to fork", { line, role: lj.role });
  }
  tell(`line ${line} retired (${reason}); ${forked ? `forked ${forked} from ${from}` : "no active line with 5 settled jobs to fork"}`);
  return { retired: true, forked, from };
}
/** Retire when the line was a candidate in at least 10 picks and its share was under 5% in each of the last 10. */
function pickRetire(line: string, now: number) {
  const lj = readLine(line); if (!lj || lj.status === "retired") return;
  const rows = scoreDb().query("SELECT candidates_json FROM picks WHERE kind = 'line' AND role = ? AND prob IS NOT NULL ORDER BY id DESC LIMIT 200").all(lj.role) as { candidates_json: string | null }[];
  const ps: number[] = [];
  for (const r of rows) { try { const c = (JSON.parse(r.candidates_json ?? "[]") as { line: string; p?: number }[]).find((x) => x.line === line); if (c && typeof c.p === "number") ps.push(c.p); } catch { /* bad row */ } if (ps.length >= LIFE_PICKS) break; }
  if (ps.length >= LIFE_PICKS && ps.every((p) => p < LIFE_PICK_P)) retireLine(line, `${LIFE_PICKS} picks under ${LIFE_PICK_P * 100}%`, now);
}
/** After a settle: walk the line's graded jobs it has not looked at yet against the role median of the last 20 rewards.
 *  3 below in a row: probation. On probation: 1 at or above: active again; 2 more below: retired (and the best line forked).
 *  The first run on a line looks at its newest job only, so turning this on never retires a line for its old history. */
export function lifecycle(line: string, now = Date.now()): { status: LineStatus; changed: boolean } | null {
  const lj = readLine(line); if (!lj) return null;
  if (lj.status === "retired") return { status: lj.status, changed: false };
  const jobs = (scoreDb().query("SELECT closed_at, grade, provisional, verified, done, rework FROM job_scores WHERE agent = ? AND grade IS NOT NULL ORDER BY closed_at, id").all(line) as { closed_at: number; grade: number; provisional: number; verified: number; done: number; rework: number }[]);
  const fresh = lj.lifeAt == null ? jobs.slice(-1) : jobs.filter((r) => r.closed_at > lj.lifeAt!);
  if (!fresh.length) return { status: lj.status, changed: false };
  const was = lj.status, med = median(roleRewards(lj.role));
  for (const r of fresh) {
    lj.lifeAt = r.closed_at;
    if (med == null) continue;
    const below = rewardOf(r) < med;
    if (lj.status === "active") { lj.below = below ? (lj.below ?? 0) + 1 : 0; if (lj.below >= LIFE_PROBATION_AFTER) { setStatus(line, lj, "probation", `${LIFE_PROBATION_AFTER} jobs in a row below the role median ${med}`, now); tell(`line ${line} on probation (${LIFE_PROBATION_AFTER} jobs below the role median ${med})`); } }
    else if (lj.status === "probation") {
      if (!below) { setStatus(line, lj, "active", `a job at or above the role median ${med}`, now); tell(`line ${line} back to active`); }
      else if ((lj.below = (lj.below ?? 0) + 1) >= LIFE_RETIRE_AFTER) { writeLine(line, lj); const out = retireLine(line, `${LIFE_RETIRE_AFTER} more jobs below the role median ${med} on probation`, now); return { status: "retired", changed: out.retired }; }
    }
  }
  writeLine(line, lj);
  return { status: lj.status, changed: lj.status !== was };
}
/** Root: undo a retire. */
export function activateLine(line: string, now = Date.now()): boolean {
  const lj = readLine(line); if (!lj) throw new Error(`no line ${line}`);
  if (lj.status === "active") return false;
  setStatus(line, lj, "active", "root activated it", now); writeLine(line, lj); return true;
}

// ---------- checks (an identical copy of the matcher lives in plugin/hooks/register.ts; test/upgrade-hooks.test.ts keeps them equal) ----------
export type Check = { tool: string; command_includes: string; output_includes?: string } | { file_glob: string } | { commit_msg_includes: string } | { judgment: true };
export interface Call { tool: string; input: Record<string, unknown>; output: string; isError?: boolean }
// ---- copy start (keep equal to plugin/hooks/register.ts) ----
/** Heredoc bodies out (they are data, not commands), then one entry per simple command, env prefixes and openers stripped. */
export function cmdSegments(cmd: string): string[] {
  const noDoc = cmd.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, "<<DOC");
  return noDoc.split(/&&|\|\||;|\||\n/).map((s) => s.trim().replace(/^[({!\s]+/, "").replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "").trim()).filter(Boolean);
}
/** A command that only prints: echo, printf, true, `:` or `cat <<`. Its text proves nothing. */
export const printOnly = (seg: string) => /^(?:echo|printf|true|:)(?:\s|$)/.test(seg) || /^cat\s*<</.test(seg);
const globRe = (g: string) => new RegExp((g.startsWith("/") ? "^" : "(?:^|/)") + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?") + "$");
const around = (s: string, needle: string) => { const i = s.indexOf(needle); return (i < 0 ? s : s.slice(Math.max(0, i - 60), i + needle.length + 100)).replace(/\s+/g, " ").trim(); };
const inputText = (input: Record<string, unknown>) => Object.values(input).filter((v): v is string => typeof v === "string").join("\n");
/** The evidence (at most 200 chars) when `call` satisfies `check`, else null. A judgment check never matches a call. */
export function matchCheck(check: Check, call: Call): string | null {
  if ("judgment" in check || call.isError) return null;
  const cmd = call.tool === "Bash" && typeof call.input.command === "string" ? call.input.command : null;
  let ev: string | null = null;
  if ("file_glob" in check) {
    const p = call.input.file_path ?? call.input.notebook_path;
    if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(call.tool) && typeof p === "string" && globRe(check.file_glob).test(p)) ev = `${call.tool} ${p}`;
  } else if ("commit_msg_includes" in check) {
    if (cmd && cmd.includes(check.commit_msg_includes) && cmdSegments(cmd).some((s) => !printOnly(s) && /\bgit\b[\s\S]*\bcommit\b/.test(s)) && /\[[^\]\n]+ [0-9a-f]{7,40}\]/.test(call.output)) ev = `git commit: ${around(cmd, check.commit_msg_includes)}`;
  } else if (call.tool === check.tool) {
    const text = cmd ?? inputText(call.input);
    const seg = cmd ? cmdSegments(cmd).find((s) => !printOnly(s) && s.includes(check.command_includes)) : text.includes(check.command_includes) ? text : undefined;
    if (seg != null) {
      if (!check.output_includes) ev = `${call.tool}: ${around(seg, check.command_includes)}`;
      else if (call.output.includes(check.output_includes) && !text.includes(check.output_includes)) ev = `${call.tool}: ${around(seg, check.command_includes)} => ${around(call.output, check.output_includes)}`;
    }
  }
  return ev == null ? null : redact(ev).slice(0, 200);
}
// ---- copy end ----

/** The tool calls of a transcript (jsonl): each tool_use with its tool_result text. */
export function transcriptCalls(file: string | null): Call[] {
  if (!file) return [];
  let raw = ""; try { raw = readFileSync(file, "utf8"); } catch { return []; }
  const calls = new Map<string, Call>();
  const textOf = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : "")).join("\n") : "";
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    let j: { message?: { content?: unknown } }; try { j = JSON.parse(l); } catch { continue; }
    const content = j.message?.content; if (!Array.isArray(content)) continue;
    for (const b of content as Record<string, unknown>[]) {
      if (b?.type === "tool_use" && typeof b.id === "string") calls.set(b.id, { tool: String(b.name ?? ""), input: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>, output: "" });
      else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") { const c = calls.get(b.tool_use_id); if (c) { c.output = textOf(b.content); c.isError = b.is_error === true; } }
    }
  }
  return [...calls.values()];
}

// ---------- upgrades ----------
export type Scope = "every_step" | "before_report";
export interface Upgrade { text: string; scope: Scope; check: Check }
export interface VersionRow { id: number; line: string; version: number; parent_version: number; upgrade_json: string; born_gen: number; status: "pending" | "kept" | "reverted" | "pruned"; reward: number | null; adherence: number | null; baseline: number | null; lesson: string | null; created: number; settled_at: number | null }
const meaningful = (s: unknown): s is string => typeof s === "string" && s.trim().length >= 4 && /[A-Za-z0-9]/.test(s);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Dice coefficient over character bigrams of the normalised texts (1 = same). */
export function similarity(a: string, b: string): number {
  const bg = (s: string) => { const m = new Map<string, number>(), t = norm(s); for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const x = bg(a), y = bg(b); let both = 0, nx = 0, ny = 0;
  for (const v of x.values()) nx += v; for (const v of y.values()) ny += v;
  for (const [k, v] of x) both += Math.min(v, y.get(k) ?? 0);
  return nx + ny ? (2 * both) / (nx + ny) : norm(a) === norm(b) ? 1 : 0;
}
const canon = (c: Check) => JSON.stringify(Object.keys(c).sort().map((k) => [k, (c as Record<string, unknown>)[k]]));
/** The check of an upgrade body, or the reason it is not one. */
export function parseCheck(x: unknown): Check | { error: string } {
  const c = x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : null;
  if (!c) return { error: "check must be an object: {tool, command_includes, output_includes?} | {file_glob} | {commit_msg_includes} | {judgment: true}" };
  const short = (k: string) => ({ error: `check.${k} must be at least 4 characters and not only spaces or punctuation` });
  if (c.judgment === true) return { judgment: true };
  if ("file_glob" in c) return meaningful(c.file_glob) ? { file_glob: c.file_glob.trim() } : short("file_glob");
  if ("commit_msg_includes" in c) return meaningful(c.commit_msg_includes) ? { commit_msg_includes: c.commit_msg_includes } : short("commit_msg_includes");
  if ("command_includes" in c) {
    if (typeof c.tool !== "string" || !c.tool.trim()) return { error: "check.tool is the tool name the call uses, e.g. Bash" };
    if (!meaningful(c.command_includes)) return short("command_includes");
    if (/^\s*(?:echo|printf|true|cat\s*<<)\s*$/i.test(c.command_includes)) return { error: "check.command_includes can't be only echo or printf: a command that only prints proves nothing" };
    if (c.output_includes != null && !meaningful(c.output_includes)) return short("output_includes");
    return { tool: c.tool.trim(), command_includes: c.command_includes, ...(c.output_includes != null ? { output_includes: String(c.output_includes) } : {}) };
  }
  return { error: "check must be one of {tool, command_includes, output_includes?} | {file_glob} | {commit_msg_includes} | {judgment: true}" };
}
export const versionsOf = (line: string) => scoreDb().query("SELECT * FROM line_versions WHERE line = ? ORDER BY born_gen").all(line) as VersionRow[];
export const upgradeOf = (line: string, gen: number) => scoreDb().query("SELECT * FROM line_versions WHERE line = ? AND born_gen = ?").get(line, gen) as VersionRow | null;
export const upgradeById = (id: number) => scoreDb().query("SELECT * FROM line_versions WHERE id = ?").get(id) as VersionRow | null;
export const bodyOf = (r: VersionRow): Upgrade => JSON.parse(r.upgrade_json) as Upgrade;

export interface Who { id: string; name: string; gen: number; kind?: string; standing?: number | null }
/** An agent the upgrade gate applies to: lines on, not root or a member or standing, and its line exists. */
export const eligible = (a: Who) => linesOn() && a.name !== "root" && !a.id.startsWith("@") && a.kind !== "member" && Number(a.standing ?? 0) !== 1 && !!readLine(a.name);

/** Validate and accept the generation's one upgrade. `calls` are its tool calls so far (the transcript). */
export function proposeUpgrade(a: Who, b: Record<string, unknown>, calls: Call[] = callsOf(a), now = Date.now()): { row: VersionRow } | { error: string; status: 409 | 422 } {
  const line = readLine(a.name); if (!line) return { error: `agentnet: ${a.name} has no line yet`, status: 409 };
  if (upgradeOf(a.name, a.gen)) return { error: "agentnet: this generation already has its upgrade: one per generation", status: 409 };
  const text = typeof b.text === "string" ? b.text.replace(/\s+/g, " ").trim() : "";
  if (text.length < 20 || text.length > 300) return { error: `agentnet: text must be 20 to 300 characters (it has ${text.length})`, status: 422 };
  const scope = b.scope === "every_step" || b.scope === "before_report" ? b.scope : null;
  if (!scope) return { error: "agentnet: scope must be every_step or before_report", status: 422 };
  const check = parseCheck(b.check); if ("error" in check) return { error: `agentnet: ${check.error}`, status: 422 };
  if (!("judgment" in check)) { const hit = calls.find((c) => matchCheck(check, c)); if (hit) return { error: "agentnet: that check is already satisfied by what you did before proposing it. Pick a check you have not met yet.", status: 422 }; }
  for (const r of versionsOf(a.name).filter((x) => x.status === "reverted")) {
    const u = bodyOf(r);
    if (similarity(u.text, text) >= 0.8 || canon(u.check) === canon(check)) return { error: `agentnet: this is close to an upgrade the line already reverted: "${u.text.slice(0, 120)}". Propose a different one.`, status: 422 };
  }
  const version = Math.max(line.current, ...versionsOf(a.name).filter((r) => r.status !== "reverted").map((r) => r.version)) + 1; // current+1; a reverted row leaves no folder, so its number is free again
  scoreDb().run("INSERT INTO line_versions (line, version, parent_version, upgrade_json, born_gen, status, created) VALUES (?, ?, ?, ?, ?, 'pending', ?)", [a.name, version, line.current, JSON.stringify({ text, scope, check }), a.gen, now]);
  return { row: upgradeOf(a.name, a.gen)! };
}
/** The agent's current transcript file, found the way the feed finds it but strictly: its session's file (by project, or by the
 *  pid file), never the feed's "newest file in the project dir" fallback, which on a shared ~/.claude can be another agent's. */
export function transcriptOf(a: { id: string; name: string }): string | null {
  const s = get(a.id); if (!s) return null;
  try { return transcriptFor({ session: s.session, project: s.project, pid: s.pid, name: a.name }, { strict: true }); } catch { return null; }
}
/** Session ids this agent generation said hello with, in order (a /clear or a resume adds one). A session belongs to the agent whose
 *  hello named it first: a later hello naming another agent's session does not make that transcript this agent's. */
export function sessionsOf(agentId: string): string[] {
  const rows = db().query("SELECT agent_id, json_extract(data, '$.session') AS session FROM agent_events WHERE type = 'AgentConnected' AND json_extract(data, '$.session') IN (SELECT json_extract(data, '$.session') FROM agent_events WHERE agent_id = ? AND type = 'AgentConnected') ORDER BY seq").all(agentId) as { agent_id: string; session: string | null }[];
  const owner = new Map<string, string>();
  for (const r of rows) if (r.session && !owner.has(r.session)) owner.set(r.session, r.agent_id);
  return [...owner].filter(([, id]) => id === agentId).map(([s]) => s);
}
/** Every transcript file of this agent generation: one per session it owns, in its project dir (or the dir of its current file). */
export function transcriptsOf(a: { id: string; name: string }): string[] {
  const row = db().query("SELECT project FROM agents WHERE id = ?").get(a.id) as { project: string | null } | null;
  const cur = transcriptOf(a), dirs = new Set<string>();
  if (row?.project) dirs.add(projectDir(row.project, a.name));
  if (cur) dirs.add(dirname(cur));
  const out: string[] = [];
  for (const s of sessionsOf(a.id)) for (const d of dirs) { const f = join(d, `${s}.jsonl`); if (existsSync(f) && !out.includes(f)) out.push(f); }
  return out;
}
/** The tool calls of an agent's own transcript so far. */
export const callsOf = (a: { id: string; name: string }): Call[] => transcriptCalls(transcriptOf(a));

// ---------- proof ----------
// A hook proof is a claim: the tool_use_id of a call in the agent's own transcript. It counts only once the server finds that call
// (after the upgrade was accepted, with a result) and its own matchCheck says it satisfies the check. An agent proof (judgment
// checks only) has no call to check and is stored verified. Only verified rows count for the gates and for settle.
export type ProofStatus = "unverified" | "verified" | "rejected";
export interface Proof { id: number; line: string; gen: number; upgrade_id: number; source: "hook" | "agent"; evidence: string; at: number; status: ProofStatus; tool_use_id: string | null; agent_id: string | null; call_at: number | null; reason: string | null }
const TOOL_USE_ID = /^[A-Za-z0-9_-]{8,128}$/;
/** Verified proofs of a generation; `since` compares the call's time (or the post time of an agent proof). */
export const proofsOf = (line: string, gen: number, since = 0) => scoreDb().query("SELECT * FROM upgrade_proofs WHERE line = ? AND gen = ? AND status = 'verified' AND COALESCE(call_at, at) > ? ORDER BY id").all(line, gen, since) as Proof[];
/** Every proof row of a generation, rejected and unverified ones too (root's sample). */
export const allProofsOf = (line: string, gen?: number) => (gen == null ? scoreDb().query("SELECT * FROM upgrade_proofs WHERE line = ? ORDER BY id").all(line) : scoreDb().query("SELECT * FROM upgrade_proofs WHERE line = ? AND gen = ? ORDER BY id").all(line, gen)) as Proof[];
const proofById = (id: number) => scoreDb().query("SELECT * FROM upgrade_proofs WHERE id = ?").get(id) as Proof | null;

/** One call of a transcript by tool_use id: the call, its tool_result (if there is one yet) and the time of the tool_use row. */
export function transcriptCall(file: string | null, id: string): { call: Call; result: boolean; at: number | null } | null {
  if (!file) return null;
  let raw = ""; try { raw = readFileSync(file, "utf8"); } catch { return null; }
  let hit: { call: Call; result: boolean; at: number | null } | null = null;
  const textOf = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : "")).join("\n") : "";
  for (const l of raw.split("\n")) {
    if (!l.includes(id)) continue;
    let j: { timestamp?: unknown; message?: { content?: unknown } }; try { j = JSON.parse(l); } catch { continue; }
    const content = j.message?.content; if (!Array.isArray(content)) continue;
    for (const b of content as Record<string, unknown>[]) {
      if (b?.type === "tool_use" && b.id === id && !hit) { const t = typeof j.timestamp === "string" ? Date.parse(j.timestamp) : NaN; hit = { call: { tool: String(b.name ?? ""), input: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>, output: "" }, result: false, at: Number.isFinite(t) ? t : null }; }
      else if (b?.type === "tool_result" && b.tool_use_id === id && hit && !hit.result) { hit.call.output = textOf(b.content); hit.call.isError = b.is_error === true; hit.result = true; }
    }
  }
  return hit;
}
/** Check one unverified claim against the transcript. `final` (settle): a call still not there is rejected. Returns the row after. */
export function verifyProof(id: number, final = false): Proof | null {
  const p = proofById(id); if (!p || p.status !== "unverified") return p;
  const up = upgradeById(p.upgrade_id), check = up ? bodyOf(up).check : null;
  let t: ReturnType<typeof transcriptCall> = null; // the call in any of this generation's own session files
  for (const f of p.agent_id ? transcriptsOf({ id: p.agent_id, name: p.line }) : []) { const x = transcriptCall(f, p.tool_use_id ?? ""); if (x && (!t || (x.result && !t.result))) t = x; if (t?.result) break; }
  let reason: string | null = null, evidence: string | null = null;
  if (!up || !check) reason = "no match";
  else if (!t || !t.result) { if (!final) return p; reason = "not in transcript"; }
  else if (t.at == null || t.at < up.created) reason = "before upgrade";
  else if (t.call.isError) reason = "error result";
  else if (!(evidence = matchCheck(check, t.call))) reason = "no match";
  if (reason) {
    scoreDb().run("UPDATE upgrade_proofs SET status = 'rejected', reason = ?, call_at = ? WHERE id = ?", [reason, t?.at ?? null, id]);
    logEvent("warn", "upgrade proof rejected", { agent: p.line, gen: p.gen, tool_use_id: p.tool_use_id, reason });
  } else scoreDb().run("UPDATE upgrade_proofs SET status = 'verified', evidence = ?, call_at = ?, reason = NULL WHERE id = ?", [evidence, t!.at, id]);
  return proofById(id);
}
/** Verify every unverified claim of a generation (the gate: not final; settle: final). */
export function checkClaims(line: string, gen: number, final = false) {
  for (const r of scoreDb().query("SELECT id FROM upgrade_proofs WHERE line = ? AND gen = ? AND status = 'unverified' ORDER BY id").all(line, gen) as { id: number }[]) verifyProof(r.id, final);
}
/** Store a proof of the generation's upgrade. Hook: a claim with the tool_use_id of a call, verified against the transcript (now,
 *  again after 2 s, and at the gate and settle). Agent: only for a judgment check, stored verified at half weight. */
export function addProof(a: Who, source: "hook" | "agent", b: Record<string, unknown>, now = Date.now()): { proof: Proof } | { error: string; status: 404 | 409 | 422 } {
  const up = upgradeOf(a.name, a.gen); if (!up) return { error: "agentnet: no upgrade accepted for this generation: self_upgrade first", status: 404 };
  if (b.upgrade_id != null && Number(b.upgrade_id) !== up.id) return { error: "agentnet: that is not this generation's upgrade", status: 409 };
  const judgment = "judgment" in bodyOf(up).check;
  if (source === "agent" && !judgment) return { error: "agentnet: agent proof is only for judgment checks: a machine check is proven by the hooks when you do the thing", status: 409 };
  if (source === "hook" && judgment) return { error: "agentnet: a judgment check is proven with upgrade_proof", status: 409 };
  if (source === "agent") {
    const evidence = typeof b.evidence === "string" ? redact(b.evidence.replace(/\s+/g, " ").trim()).slice(0, 200) : "";
    if (!evidence) return { error: "agentnet: evidence is required", status: 422 };
    const r = scoreDb().run("INSERT INTO upgrade_proofs (line, gen, upgrade_id, source, evidence, at, status, agent_id) VALUES (?, ?, ?, 'agent', ?, ?, 'verified', ?)", [a.name, a.gen, up.id, evidence, now, a.id]);
    return { proof: proofById(Number(r.lastInsertRowid))! };
  }
  const tid = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
  if (!TOOL_USE_ID.test(tid)) return { error: "agentnet: tool_use_id is required: the id of the call that did the check", status: 422 };
  if (scoreDb().query("SELECT 1 FROM upgrade_proofs WHERE line = ? AND gen = ? AND tool_use_id = ?").get(a.name, a.gen, tid)) return { error: "agentnet: that call was already claimed", status: 409 };
  const r = scoreDb().run("INSERT INTO upgrade_proofs (line, gen, upgrade_id, source, evidence, at, status, tool_use_id, agent_id) VALUES (?, ?, ?, 'hook', 'claim', ?, 'unverified', ?, ?)", [a.name, a.gen, up.id, now, tid, a.id]);
  return { proof: verifyProof(Number(r.lastInsertRowid))! };
}
/** The gate at step_done (kind step, `since` = when the previous step closed) and at the done report. Null = allowed, else the refusal. */
export function lineGate(a: Who, kind: "step" | "report", since: number): { rule: string; detail: string } | null {
  if (!eligible(a)) return null;
  const up = upgradeOf(a.name, a.gen);
  if (!up) return kind === "step" ? { rule: "upgrade-first", detail: "agentnet: propose your upgrade first: self_upgrade {text, scope, check}. One rule you will follow in this job, with a check the hooks can see." } : null;
  const u = bodyOf(up);
  checkClaims(a.name, a.gen); // a claim the transcript did not have at post time
  if (kind === "step" && u.scope === "every_step" && !proofsOf(a.name, a.gen, since).length) return { rule: "upgrade-proof", detail: `agentnet: your upgrade is not proven since your last step. Do it, then close the step. Your upgrade: ${u.text}` };
  if (kind === "report" && u.scope === "before_report" && !proofsOf(a.name, a.gen).length) return { rule: "upgrade-proof", detail: `agentnet: your upgrade is not proven yet, so the done report waits. Do it, then report. Your upgrade: ${u.text}` };
  return null;
}

// ---------- reward, keep / revert ----------
export const ALPHA = 0.3;
const clamp = (x: number) => Math.max(0, Math.min(5, x));
/** Reward 0-5: half hard signals (5 x verified share, minus 1 for rework), half the grade; a provisional auto grade weighs half of that. */
export function rewardOf(r: { grade: number | null; provisional: number; verified: number; done: number; rework: number }): number {
  const hard = clamp(5 * (r.done > 0 ? r.verified / r.done : 0) - (r.rework ? 1 : 0)), g = r.grade ?? 0;
  return Math.round((r.provisional ? 0.75 * hard + 0.25 * g : 0.5 * hard + 0.5 * g) * 100) / 100;
}
/** Adherence: at least one hook proof, or two agent proofs for a judgment check. */
export const adheres = (p: Pick<Proof, "source">[]) => p.some((x) => x.source === "hook") || p.filter((x) => x.source === "agent").length >= 2;
/** EWMA over rewards in order (the first one sets it). */
export const ewma = (rewards: number[]) => rewards.reduce<number | null>((b, r) => (b == null ? r : (1 - ALPHA) * b + ALPHA * r), null);
const round = (x: number | null) => (x == null ? null : Math.round(x * 100) / 100);
/** Keep or revert the generation's upgrade from its job's score row. Idempotent per (line, gen): a second run with the same grade
 *  changes nothing; a changed grade that flips the decision undoes the earlier one. Returns the decision, or null when there is nothing to settle. */
export function settleLine(line: string, gen: number, job: number, now = Date.now()): { status: "kept" | "reverted"; reward: number; baseline: number | null; adherence: boolean; changed: boolean } | null {
  const up = upgradeOf(line, gen), lj = readLine(line); if (!up || !lj) return null;
  const sr = jobScoreRow(`${line}#${gen}`, job); if (!sr) return null;
  const reward = rewardOf({ grade: sr.grade, provisional: sr.provisional, verified: sr.verified, done: sr.done, rework: sr.rework });
  checkClaims(line, gen, true); // a claim still not in the transcript is rejected now
  const proofs = proofsOf(line, gen), adherence = adheres(proofs);
  const before = round(ewma(versionsOf(line).filter((r) => r.born_gen < gen && r.status !== "pending" && r.reward != null).map((r) => r.reward!)));
  const status = adherence && (before == null || reward >= before) ? "kept" : "reverted";
  const u = bodyOf(up), was = up.status;
  if (was === status && up.reward === reward && up.baseline === before) return { status, reward, baseline: before, adherence, changed: false };
  let lesson: string | null = up.lesson;
  if (was !== status) {
    // undo the earlier decision
    if (was === "kept" && lj.current === up.version) { rmSync(selfDir(line, up.version), { recursive: true, force: true }); lj.current = up.parent_version; }
    else if (was === "kept") logEvent("warn", "line regrade: a later version builds on this one, left in place", { line, gen, version: up.version, current: lj.current });
    if (was === "reverted" && up.lesson) { const v = lj.current, p = join(selfDir(line, v), "lessons.md"); put(p, readText(p).split("\n").filter((l) => l !== up.lesson).join("\n")); lesson = null; }
    // the new one
    if (status === "kept") {
      if (lj.current === up.parent_version) {
        const dst = selfDir(line, up.version); assertInHome(dst, "line self");
        rmSync(dst, { recursive: true, force: true }); cpSync(selfDir(line, up.parent_version), dst, { recursive: true });
        appendSelf(line, up.version, "rules.md", u.text); lj.current = up.version;
      } else logEvent("warn", "line regrade: the line moved on, the kept version is not made current", { line, gen, current: lj.current });
    } else {
      lesson = adherence ? `Don't: ${u.text} (reward ${reward}, baseline ${before ?? "none"})` : `Upgrade not followed: ${u.text}`;
      appendSelf(line, lj.current, "lessons.md", lesson);
    }
  } else if (status === "reverted" && up.lesson && up.reward !== reward) { // same decision, new numbers: rewrite the lesson line
    const nl = adherence ? `Don't: ${u.text} (reward ${reward}, baseline ${before ?? "none"})` : `Upgrade not followed: ${u.text}`, p = join(selfDir(line, lj.current), "lessons.md");
    put(p, readText(p).split("\n").map((l) => (l === up.lesson ? nl : l)).join("\n")); lesson = nl;
  }
  scoreDb().run("UPDATE line_versions SET status = ?, reward = ?, adherence = ?, baseline = ?, lesson = ?, settled_at = ? WHERE id = ?", [status, reward, +adherence, before, status === "kept" ? null : lesson, now, up.id]);
  lj.baseline = round(ewma(versionsOf(line).filter((r) => r.status !== "pending" && r.reward != null).map((r) => r.reward!)));
  writeLine(line, lj);
  return { status, reward, baseline: before, adherence, changed: true };
}

/** One lesson on a line's current self, from outside the settle (owner events, ownerLearn.ts). Skips a line that has no file or the same lesson. */
export function addLesson(line: string, text: string): boolean {
  if (!LINE_RE.test(line)) return false;
  const lj = readLine(line); if (!lj) return false;
  const t = text.replace(/\s+/g, " ").trim(); if (!t || readSelf(line, lj.current, "lessons.md").split("\n").includes(t)) return false;
  appendSelf(line, lj.current, "lessons.md", t); return true;
}

// ---------- the boot section ----------
/** The lines block of a new generation's boot prompt (lines on): aim, rules, last 10 lessons, the parent's grade, the last 3 settled upgrades. */
export function bootSection(name: string): string {
  if (!linesOn()) return "";
  const lj = readLine(name); if (!lj) return "";
  const row = db().query("SELECT gen, standing, kind FROM agents WHERE name = ? ORDER BY gen DESC LIMIT 1").get(name) as { gen: number; standing: number | null; kind: string } | null;
  if (!row || row.kind === "member" || Number(row.standing ?? 0) === 1 || name === "root") return "";
  const parent = scoreDb().query("SELECT gen, job_id, grade FROM job_scores WHERE agent = ? AND gen < ? AND grade IS NOT NULL ORDER BY gen DESC, job_id DESC LIMIT 1").get(name, row.gen) as { gen: number; job_id: number; grade: number } | null;
  const rules = readSelf(name, lj.current, "rules.md").trim(), lessons = readSelf(name, lj.current, "lessons.md").split("\n").filter((l) => l.trim()).slice(-10);
  const last = versionsOf(name).filter((r) => r.status !== "pending").slice(-3).reverse();
  return [
    `## Your line (${name}, self v${lj.current})`,
    "Aim: the highest grade for this job.",
    `Parent generation's grade: ${parent ? `${parent.grade}/5 (gen ${parent.gen} job ${parent.job_id})` : "none yet"}.`,
    `Rules this line keeps:\n${rules ? rules.split("\n").map((l) => `- ${l}`).join("\n") : "- none yet"}`,
    `Lessons (last ${lessons.length || 0}):\n${lessons.length ? lessons.map((l) => `- ${l}`).join("\n") : "- none yet"}`,
    `Last upgrades:\n${last.length ? last.map((r) => `- ${r.status}: "${bodyOf(r).text}" (reward ${r.reward ?? "?"}, baseline ${r.baseline ?? "none"})`).join("\n") : "- none yet"}`,
    "Before your first step_done, propose one upgrade with mcp__agentnet__self_upgrade {text, scope: every_step | before_report, check}: one rule you will follow in this job, with a check the hooks can see (a tool call, a file you write, a commit message) or {judgment: true}. It is kept only if you follow it and the job scores at least the line's baseline.",
  ].join("\n\n");
}

// ---------- graded memory (step 8b) ----------
/** The job's reward (rewardOf over its score row) into every trail note the job wrote. Never throws. */
export function noteReward(agent: string, gen: number, job: number): number {
  try {
    const sr = jobScoreRow(`${agent}#${gen}`, job); if (!sr || sr.grade == null) return 0;
    return setNoteReward(`${agent}#${gen}`, job, rewardOf({ grade: sr.grade, provisional: sr.provisional, verified: sr.verified, done: sr.done, rework: sr.rework }));
  } catch (e) { logEvent("warn", "note reward failed", { agent, gen, job, error: (e as Error).message }); return 0; }
}

// ---------- handlers ----------
let registered = false;
/** Settle on despawn and again on every root regrade. Imported lazily by server.ts so tests opt in. */
export async function registerLineHandlers() {
  if (registered) return; registered = true;
  const { onDespawn, onRegrade } = await import("./finish");
  const { toRoot } = await import("./finish");
  setLineTell((text) => { try { toRoot(text, text.slice(0, 60)); } catch (e) { logEvent("warn", "line message failed", { error: (e as Error).message }); } });
  const life = (line: string) => { if (!linesOn()) return; try { lifecycle(line); } catch (e) { logEvent("warn", "line life cycle failed", { line, error: (e as Error).message }); } };
  onDespawn("lines.settle", (p) => { try { settleLine(p.agent, p.gen, p.job); } finally { life(p.agent); noteReward(p.agent, p.gen, p.job); } });
  onRegrade((r) => { try { settleLine(r.agent, r.gen, r.job); } finally { life(r.agent); noteReward(r.agent, r.gen, r.job); } });
}
