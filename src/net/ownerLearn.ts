// Learning on owner events only (docs/internal/SPEC-asks-ledger.md (e)): rework, complaint, owner mark, praise. No model calls here.
// A lesson goes on the line of each agent that worked on the goal (root's line for a mark on root's breakdown). Praise saves a liked
// example under $AGENTNET_HOME/liked/<role>/ that the next agent of that role or project reads first, and raises the job's trail reward.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dir, ROOT } from "../core/config";
import { db, schema } from "../core/db";
import { assertInHome } from "../core/paths";
import { logEvent } from "../core/logger";
import { jobsOf } from "./jobs";
import { addLesson, allLines, bodyOf, linesOn, matchCheck, selfDir, tellRoot, transcriptCalls, transcriptsOf, versionsOf, type VersionRow } from "./lines";
import { scoreDb } from "./scores";
import { get } from "./store";
import { setNoteReward } from "./trails";
import { claudeModel, learnFns, linksOf, type GoalRow, type LearnEvent, type Model } from "./ownerAsks";

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const LIKED_CAP = 1500, BOOT_EACH = 600, BOOT_CAP = 1200, LIKED_REWARD = 5;
export const likedDir = () => join(ROOT, "liked");
/** The role of an agent name: the name minus its number ("web-dev-2" → "web-dev"). */
export const roleOf = (name: string) => name.replace(/-\d+$/, "");

let ready = false;
function ensure() {
  if (ready) return; ready = true;
  schema(`CREATE TABLE IF NOT EXISTS owner_learned (goal_id INTEGER NOT NULL, agent_id TEXT NOT NULL, job_id INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (goal_id, agent_id, job_id, type))`);
}
/** At most one lesson per job per event type: true the first time. */
const once = (goal: number, agentId: string, job: number, type: string, now: number) =>
  db().run("INSERT OR IGNORE INTO owner_learned (goal_id, agent_id, job_id, type, at) VALUES (?, ?, ?, ?, ?)", [goal, agentId, job, type, now]).changes > 0;

export interface Learned { lessons: string[]; liked: string[] }
/** One owner event → lessons and liked examples. Returns what it wrote (tests and the log read it). */
export function onOwnerEvent(e: LearnEvent, now = Date.now()): Learned {
  ensure(); const out: Learned = { lessons: [], liked: [] }, g = e.goal; if (!g) return out;
  const lesson = (line: string, text: string) => { if (addLesson(line, text)) out.lessons.push(`${line}: ${text}`); };
  if (e.type === "mark") { // root wrote the breakdown: the lesson is root's
    const text = e.mark === "missing" ? `Breakdown missed: ${clip(e.text, 140)} (G${g.id})` : `Breakdown: ${clip(e.text, 120)} was ${e.mark === "wrong" ? "wrong" : "not wanted"} (G${g.id})`;
    if (once(g.id, "@root", e.item?.id ?? 0, `mark-${e.mark}`, now)) lesson("root", text);
    return out;
  }
  for (const l of linksOf(g.id)) {
    if (!once(g.id, l.agent_id, l.job_id, e.type, now)) continue;
    if (e.type === "rework") lesson(l.agent, `Rework: ${clip(g.text, 80)} came back (${clip(e.text, 120)})`);
    else if (e.type === "complaint") lesson(l.agent, `Owner complaint: ${clip(e.text, 140)}`);
    else if (e.type === "praise") { const f = saveLiked(g, l.agent_id, l.agent, l.job_id, e.text, now); if (f) out.liked.push(f); }
  }
  if (out.lessons.length || out.liked.length) logEvent("info", "owner event learned", { type: e.type, goal: g.id, lessons: out.lessons.length, liked: out.liked.length });
  return out;
}

/** The liked example: his words, the job goal, the last report, each step with its proof. ≤ 1.5 kB. */
function saveLiked(g: GoalRow, agentId: string, agent: string, jobId: number, praise: string, now: number): string | null {
  const s = get(agentId), job = s ? jobsOf(s).find((j) => j.id === jobId) : undefined;
  const row = db().query("SELECT gen, project FROM agents WHERE id = ?").get(agentId) as { gen: number; project: string | null } | null;
  const report = db().query("SELECT body FROM messages WHERE from_agent = ? AND kind = 'report' ORDER BY id DESC LIMIT 1").get(agentId) as { body: string } | null;
  const steps = (job?.steps ?? []).filter((x) => x.status === "done").map((x) => `- ${clip(x.text, 110)}${x.evidence.find((v) => v.ok) ? ` [${clip(`${x.evidence.find((v) => v.ok)!.kind}: ${x.evidence.find((v) => v.ok)!.value}`, 90)}]` : ""}`);
  const md = [`# Liked: ${agent} job ${jobId}`, `project: ${row?.project ?? "-"}`, "", `Owner asked (G${g.id}): ${clip(g.text, 300)}`, `Owner said: ${clip(praise, 160)}`,
    job?.goal ? `Job goal: ${clip(job.goal, 200)}` : "", report ? `Report: ${clip(report.body, 300)}` : "", steps.length ? `Steps and proof:\n${steps.join("\n")}` : ""].filter(Boolean).join("\n");
  const d = join(likedDir(), roleOf(agent)); assertInHome(d, "liked");
  mkdirSync(d, { recursive: true });
  const f = join(d, `${agent}-g${row?.gen ?? 0}-j${jobId}.md`);
  writeFileSync(f, md.length > LIKED_CAP ? `${md.slice(0, LIKED_CAP - 1)}…` : md, { mode: 0o600 });
  try { setNoteReward(agentId, jobId, LIKED_REWARD); } catch (e) { logEvent("warn", "liked: trail reward failed", { error: String(e) }); }
  void now; return f;
}

/** The boot-prompt block: the newest 2 liked examples of this role or project, each ≤ 600 chars, ≤ 1.2 kB in all. "" when none. */
export function likedSection(name: string, project: string | null): string {
  const root = likedDir(); if (!existsSync(root)) return "";
  const files: { f: string; t: number; role: boolean }[] = [];
  for (const r of readdirSync(root)) {
    const d = join(root, r); let names: string[]; try { names = readdirSync(d); } catch { continue; }
    for (const n of names) if (n.endsWith(".md")) { const f = join(d, n); files.push({ f, t: statSync(f).mtimeMs, role: r === roleOf(name) }); }
  }
  const pick = files.filter((x) => x.role || (project && readFileSync(x.f, "utf8").includes(`\nproject: ${project}\n`))).sort((a, b) => b.t - a.t).slice(0, 2);
  if (!pick.length) return "";
  let body = pick.map((x) => { const t = readFileSync(x.f, "utf8"); return t.length > BOOT_EACH ? `${t.slice(0, BOOT_EACH - 1)}…` : t; }).join("\n\n");
  if (body.length > BOOT_CAP) body = `${body.slice(0, BOOT_CAP - 1)}…`;
  return `## Work the owner liked\nThe owner liked this. Follow its direction.\n\n${body}`;
}

/** Hook the handlers once (server start). */
let wired = false;
export function wireOwnerLearning() {
  if (wired) return; wired = true;
  learnFns.push((e) => { try { onOwnerEvent(e); } catch (err) { logEvent("warn", "owner learning failed", { error: String(err) }); } });
  const t = setInterval(() => { if (linesOn()) void pruneTick(Date.now(), tellRoot).catch((err) => logEvent("warn", "rule prune failed", { error: String(err) })); }, 10 * 60_000); t.unref?.();
}

// ---------- (f) the weekly rule prune ----------

export const pruneDeps: { model: Model } = { model: (s, i) => claudeModel(s, i) }; // lazy: ownerAsks -> routes -> ownerLearn is a cycle
export interface Pruned { line: string; text: string; reason: string }
export interface PruneResult { lines: number; checked: number; pruned: Pruned[]; before: number | null; after: number | null; apply: boolean }
const LATER = 3, HELP_DROP = 0.5;
const rulesOf = (line: string, v: number) => { try { return readFileSync(join(selfDir(line, v), "rules.md"), "utf8"); } catch { return ""; } };
const lessonsOf = (line: string, v: number) => { try { return readFileSync(join(selfDir(line, v), "lessons.md"), "utf8"); } catch { return ""; } };
/** What a boot prompt injects from a line: its rules and its last 10 lessons. */
const bootText = (line: string, v: number, rules = rulesOf(line, v)) => `${rules.trim()}\n${lessonsOf(line, v).split("\n").filter((l) => l.trim()).slice(-10).join("\n")}`.trim();

/** Did any of these generations' transcripts contain a call that meets the rule's check? Judgment checks cannot be seen: null. */
function followedIn(line: string, k: VersionRow, gens: number[]): boolean | null {
  const check = bodyOf(k).check; if ("judgment" in check) return null;
  for (const gen of gens) {
    const a = db().query("SELECT id, name FROM agents WHERE name = ? AND gen = ?").get(line, gen) as { id: string; name: string } | null; if (!a) continue;
    for (const f of transcriptsOf(a)) if (transcriptCalls(f).some((c) => matchCheck(check, c))) return true;
  }
  return false;
}
/** Model input tokens of a text: one call with it minus one call with nothing (both 1-word replies). Null when the model is off. */
async function countTokens(text: string, empty: number | null): Promise<number | null> {
  if (empty == null) return null;
  const r = await pruneDeps.model("Reply with the one word ok.", text || "."); return r ? Math.max(0, r.tokens - empty) : null;
}
/** Rules not followed in the line's last 3 settled jobs, or not helping (mean reward ≥ 0.5 under the baseline at keep time over ≥ 3 jobs). Dry run unless apply. */
export async function pruneRules(apply: boolean, now = Date.now(), count = true): Promise<PruneResult> {
  const pruned: Pruned[] = [], beforeText: string[] = [], afterText: string[] = []; let checked = 0;
  const ls = allLines();
  for (const { line, json } of ls) {
    const v = json.current, rules = rulesOf(line, v); let keep = rules.split("\n");
    beforeText.push(bootText(line, v, rules));
    const versions = versionsOf(line);
    for (const k of versions.filter((r) => r.status === "kept")) {
      const text = bodyOf(k).text; if (!keep.includes(text)) continue;
      checked++;
      const later = versions.filter((r) => r.born_gen > k.born_gen && (r.status === "kept" || r.status === "reverted" || r.status === "pruned") && r.reward != null).slice(-LATER);
      if (later.length < LATER) continue;
      const mean = later.reduce((s, r) => s + r.reward!, 0) / later.length;
      const reason = followedIn(line, k, later.map((r) => r.born_gen)) === false ? `not followed in the last ${LATER} jobs`
        : k.baseline != null && mean <= k.baseline - HELP_DROP ? `not helping: mean reward ${mean.toFixed(2)} after keeping, baseline ${k.baseline}` : null;
      if (!reason) continue;
      pruned.push({ line, text, reason }); keep = keep.filter((l) => l !== text);
      if (apply) {
        const p = join(selfDir(line, v), "rules.md"); assertInHome(p, "line self"); writeFileSync(p, keep.join("\n"), { mode: 0o600 });
        addLesson(line, `Pruned: ${text} (${reason})`);
        scoreDb().run("UPDATE line_versions SET status = 'pruned', lesson = ? WHERE id = ?", [`Pruned: ${reason}`, k.id]);
      }
    }
    afterText.push(apply ? bootText(line, v) : bootText(line, v, keep.join("\n")));
  }
  let before: number | null = null, after: number | null = null;
  if (count && ls.length) {
    const e = await pruneDeps.model("Reply with the one word ok.", "."), empty = e ? e.tokens : null;
    before = await countTokens(beforeText.join("\n\n"), empty);
    after = pruned.length ? await countTokens(afterText.join("\n\n"), empty) : before;
  }
  const res: PruneResult = { lines: ls.length, checked, pruned, before, after, apply };
  try { mkdirSync(dir("logs"), { recursive: true }); appendFileSync(join(dir("logs"), "rule-prune.jsonl"), JSON.stringify({ at: now, ...res }) + "\n"); } catch { /* log only */ }
  return res;
}
/** Monday after 04:00, once a week, lines on: prune for real and tell root the numbers. */
export async function pruneTick(now = Date.now(), tell: (text: string) => void = () => {}) {
  const d = new Date(now); if (d.getDay() !== 1 || d.getHours() < 4) return null;
  const f = join(dir("data"), "rule-prune.json"), week = new Date(now - 4 * 3_600_000).toDateString();
  try { if ((JSON.parse(readFileSync(f, "utf8")) as { week?: string }).week === week) return null; } catch { /* first */ }
  mkdirSync(dir("data"), { recursive: true }); writeFileSync(f, JSON.stringify({ week }));
  const r = await pruneRules(true, now);
  tell(`Weekly rule prune: ${r.pruned.length} of ${r.checked} kept rules removed across ${r.lines} lines; boot text ${r.before ?? "?"} → ${r.after ?? "?"} tokens.${r.pruned.map((p) => `\n- ${p.line}: ${p.text} (${p.reason})`).join("")}`);
  return r;
}
