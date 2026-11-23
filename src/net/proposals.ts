// Step 8b: skill and rule proposals from a line (docs/internal/one-folder/SPEC-step8b-picks.md §5).
// An agent on a line may propose a skill once its line's latest settled job had reward >= 4 (it is never told the number), and a rule
// any time. Everything waits under lines/<line>/proposals/<id>/ until root approves or rejects it. A skill goes into the line's
// current self (skills/<name>/) or claude/base/skills/<name>/; a line rule is appended to the current rules.md. A house rule is
// owner-only: root approves it only with the owner flag, and even then nothing is written (the owner applies house rules by hand).
// This path never writes to claude/base/rules or ~/.claude.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { ROOT } from "../core/config";
import { logEvent } from "../core/logger";
import { assertInHome } from "../core/paths";
import { redact } from "../core/redact";
import { baseDir } from "./agent-config";
import { allLines, lineDir, readLine, rewardOf, selfDir, tellRoot } from "./lines";
import { scoreDb } from "./scores";

export type ProposalStatus = "pending" | "approved" | "rejected";
export interface ProposalFile { path: string; bytes: number }
export interface Proposal {
  id: string; line: string; gen: number; kind: "skill" | "rule"; status: ProposalStatus; created: number;
  name?: string; summary?: string; files?: ProposalFile[];
  text?: string; target?: "line" | "house"; ownerOnly?: boolean;
  decidedAt?: number; into?: "line" | "base"; reason?: string; ownerApproved?: boolean; applied?: string | null;
}
export const SKILL_NAME = /^[a-z0-9-]{1,40}$/, MAX_BYTES = 64 * 1024, MAX_FILES = 20, MIN_REWARD = 4;
const ID = /^[a-z0-9]{6,24}$/;
const propDir = (line: string, id?: string) => join(lineDir(line), "proposals", ...(id ? [id] : []));
const propFile = (line: string, id: string) => join(propDir(line, id), "proposal.json");
function save(p: Proposal) {
  const f = propFile(p.line, p.id); assertInHome(f, "proposal");
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(`${f}.tmp`, JSON.stringify(p, null, 2) + "\n", { mode: 0o600 }); renameSync(`${f}.tmp`, f);
}
const load = (line: string, id: string): Proposal | null => { try { return JSON.parse(readFileSync(propFile(line, id), "utf8")) as Proposal; } catch { return null; } };
let seq = 0;
const newId = (now: number) => `${now.toString(36)}${(++seq % 1296).toString(36).padStart(2, "0")}`;

/** Every proposal of every line, newest first (status filter optional). */
export function listProposals(status?: ProposalStatus): Proposal[] {
  const out: Proposal[] = [];
  for (const { line } of allLines()) {
    let ids: string[] = []; try { ids = readdirSync(propDir(line)).filter((x) => ID.test(x)); } catch { continue; }
    for (const id of ids) { const p = load(line, id); if (p && (!status || p.status === status)) out.push(p); }
  }
  return out.sort((a, b) => b.created - a.created);
}
export const proposalsOf = (line: string) => listProposals().filter((p) => p.line === line);
export const findProposal = (id: string): Proposal | null => { if (!ID.test(id)) return null; for (const { line } of allLines()) { const p = load(line, id); if (p) return p; } return null; };

/** The reward of the line's latest settled (graded) job, or null. Never shown to the agent. */
export function latestReward(line: string): number | null {
  const r = scoreDb().query("SELECT grade, provisional, verified, done, rework FROM job_scores WHERE agent = ? AND grade IS NOT NULL ORDER BY closed_at DESC, id DESC LIMIT 1").get(line) as { grade: number; provisional: number; verified: number; done: number; rework: number } | null;
  return r ? rewardOf(r) : null;
}
/** A relative file path inside the skill folder: no absolute path, no `..`, plain segments. */
const goodPath = (p: string) => !!p && p.length <= 200 && !p.startsWith("/") && !p.includes("\\") && p.split("/").every((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..") && normalize(p) === p;

export type Out<T> = { ok: T } | { error: string; status: 404 | 409 | 422 };
/** propose_skill. The answer never carries a grade: "accepted for review" or "not eligible now". */
export function proposeSkill(a: { name: string; gen: number }, b: Record<string, unknown>, now = Date.now()): Out<{ id: string; state: "accepted for review" }> {
  const name = typeof b.name === "string" ? b.name.trim() : "", summary = typeof b.summary === "string" ? redact(b.summary.replace(/\s+/g, " ").trim()).slice(0, 500) : "";
  if (!SKILL_NAME.test(name)) return { error: "agentnet: name must be 1-40 characters of a-z, 0-9 and -", status: 422 };
  if (summary.length < 10) return { error: "agentnet: summary is required (what the skill does, when to use it)", status: 422 };
  const files = Array.isArray(b.files) ? b.files : [];
  if (!files.length || files.length > MAX_FILES) return { error: `agentnet: files must be 1 to ${MAX_FILES} {path, content}`, status: 422 };
  let total = 0; const clean: { path: string; content: string }[] = [];
  for (const f of files) {
    const path = f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string" ? (f as { path: string }).path.trim() : "", content = f && typeof f === "object" && typeof (f as { content?: unknown }).content === "string" ? (f as { content: string }).content : null;
    if (!goodPath(path) || content == null) return { error: `agentnet: bad file "${String(path).slice(0, 60)}": a relative path without .. and a string content`, status: 422 };
    if (clean.some((c) => c.path === path)) return { error: `agentnet: file ${path} is listed twice`, status: 422 };
    total += Buffer.byteLength(content); clean.push({ path, content });
  }
  if (total > MAX_BYTES) return { error: "agentnet: files are over 64 KB in total", status: 422 };
  const r = latestReward(a.name);
  if (r == null || r < MIN_REWARD) return { error: "agentnet: not eligible now", status: 409 };
  const id = newId(now), dir = join(propDir(a.name, id), "files");
  for (const c of clean) { const f = join(dir, c.path); assertInHome(f, "proposal file"); mkdirSync(dirname(f), { recursive: true, mode: 0o700 }); writeFileSync(f, c.content, { mode: 0o600 }); }
  save({ id, line: a.name, gen: a.gen, kind: "skill", status: "pending", created: now, name, summary, files: clean.map((c) => ({ path: c.path, bytes: Buffer.byteLength(c.content) })) });
  logEvent("info", "skill proposed", { line: a.name, gen: a.gen, id, name });
  tellRoot(`${a.name} proposed skill "${name}" (${id}): ${summary.slice(0, 160)}. Approve into line or base, or reject.`);
  return { ok: { id, state: "accepted for review" } };
}
/** propose_rule: `line` goes to root; `house` is owner-only. */
export function proposeRule(a: { name: string; gen: number }, b: Record<string, unknown>, now = Date.now()): Out<{ id: string; state: "accepted for review"; ownerOnly: boolean }> {
  const text = typeof b.text === "string" ? redact(b.text.replace(/\s+/g, " ").trim()) : "", target = b.target === "house" ? "house" : b.target === "line" ? "line" : null;
  if (text.length < 20 || text.length > 300) return { error: `agentnet: text must be 20 to 300 characters (it has ${text.length})`, status: 422 };
  if (!target) return { error: "agentnet: target must be line or house", status: 422 };
  const id = newId(now), ownerOnly = target === "house";
  save({ id, line: a.name, gen: a.gen, kind: "rule", status: "pending", created: now, text, target, ownerOnly });
  logEvent("info", "rule proposed", { line: a.name, gen: a.gen, id, target });
  tellRoot(ownerOnly ? `${a.name} proposed a HOUSE rule (${id}), owner-only: forward it to the owner and approve with owner: true only on the owner's word. "${text}"` : `${a.name} proposed a line rule (${id}): "${text}". Approve or reject.`);
  return { ok: { id, state: "accepted for review", ownerOnly } };
}

/** Root approves. Skill: copied into the line's current self or claude/base/skills (refused when that skill folder exists).
 *  Line rule: appended to the line's current rules.md. House rule: only with `owner: true`, and nothing is written. */
export function approveProposal(id: string, b: Record<string, unknown>, now = Date.now()): Out<Proposal> {
  const p = findProposal(id); if (!p) return { error: `agentnet: no proposal ${id}`, status: 404 };
  if (p.status !== "pending") return { error: `agentnet: proposal ${id} is already ${p.status}`, status: 409 };
  const lj = readLine(p.line); if (!lj) return { error: `agentnet: no line ${p.line}`, status: 404 };
  let applied: string | null = null, into: "line" | "base" | undefined;
  if (p.kind === "skill") {
    into = b.into === "base" ? "base" : b.into === "line" ? "line" : undefined;
    if (!into) return { error: "agentnet: into must be line or base", status: 422 };
    const dst = into === "line" ? join(selfDir(p.line, lj.current), "skills", p.name!) : join(baseDir(), "skills", p.name!);
    assertInHome(dst, "approved skill");
    if (existsSync(dst)) return { error: `agentnet: a skill ${p.name} already exists there`, status: 409 };
    // Read every file before writing any, so a missing proposal file leaves no half-made skill dir behind.
    let files: { out: string; body: Buffer }[];
    try { files = (p.files ?? []).map((f) => ({ out: join(dst, f.path), body: readFileSync(join(propDir(p.line, p.id), "files", f.path)) })); }
    catch { return { error: `agentnet: proposal ${id} has missing files`, status: 422 }; }
    for (const { out, body } of files) { assertInHome(out, "approved skill"); mkdirSync(dirname(out), { recursive: true, mode: 0o700 }); writeFileSync(out, body, { mode: 0o600 }); }
    applied = dst.startsWith(ROOT) ? dst.slice(ROOT.length + 1) : dst;
  } else if (p.target === "line") {
    const f = join(selfDir(p.line, lj.current), "rules.md"); assertInHome(f, "line rules");
    let t = ""; try { t = readFileSync(f, "utf8"); } catch { /* new */ }
    writeFileSync(f, `${t}${t && !t.endsWith("\n") ? "\n" : ""}${p.text}\n`, { mode: 0o600 });
    applied = `lines/${p.line}/self/v${lj.current}/rules.md`;
  } else {
    if (b.owner !== true) return { error: "agentnet: a house rule is owner-only: forward it to the owner, then approve with owner: true on the owner's word", status: 409 };
    applied = null; // the owner applies house rules by hand; this path never writes base rules or ~/.claude
  }
  const next: Proposal = { ...p, status: "approved", decidedAt: now, ...(into ? { into } : {}), ...(p.ownerOnly ? { ownerApproved: true } : {}), applied };
  save(next); logEvent("info", "proposal approved", { id, line: p.line, kind: p.kind, applied });
  return { ok: next };
}
export function rejectProposal(id: string, b: Record<string, unknown>, now = Date.now()): Out<Proposal> {
  const p = findProposal(id); if (!p) return { error: `agentnet: no proposal ${id}`, status: 404 };
  if (p.status !== "pending") return { error: `agentnet: proposal ${id} is already ${p.status}`, status: 409 };
  const reason = typeof b.reason === "string" ? b.reason.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  if (!reason) return { error: "agentnet: reason is required", status: 422 };
  const next: Proposal = { ...p, status: "rejected", decidedAt: now, reason };
  save(next); logEvent("info", "proposal rejected", { id, line: p.line });
  return { ok: next };
}
