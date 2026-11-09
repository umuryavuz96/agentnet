// Owner checks: a thing only the owner can verify in the real world ("the iPad shows a Voice button"). The row outlives the agent that
// asked: the agent may be despawned while the check stays pending. Data only; routes live in routes.ts (create, list) and checksPanel.ts (resolve).
import { db } from "../core/db";
import { ensureSchema } from "./store";
import { teamsOf } from "./teams";

export type CheckState = "pending" | "answered";
export type Tone = "good" | "bad" | "neutral";
/** One answer button the asker wrote: a short label and how it is coloured. */
export interface CheckOption { label: string; tone: Tone }
export const DEFAULT_OPTIONS: CheckOption[] = [{ label: "Works", tone: "good" }, { label: "Not yet", tone: "bad" }];
export const LABEL_MAX = 40, OPTIONS_MIN = 2, OPTIONS_MAX = 4;
const TONES: readonly string[] = ["good", "bad", "neutral"];
/** The asker's options: none given = Works / Not yet; else 2-4 with a non-empty label (max ~5 words, 40 characters) and a tone. */
export function parseOptions(x: unknown): CheckOption[] | string {
  if (x === undefined || x === null) return DEFAULT_OPTIONS.map((o) => ({ ...o }));
  if (!Array.isArray(x) || x.length < OPTIONS_MIN || x.length > OPTIONS_MAX) return `options needs ${OPTIONS_MIN}-${OPTIONS_MAX} answers`;
  const out: CheckOption[] = [];
  for (const o of x) {
    const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
    const label = typeof r.label === "string" ? r.label.replace(/\s+/g, " ").trim() : "";
    if (!label) return "every option needs a label";
    if (label.length > LABEL_MAX || label.split(" ").length > 6) return `option label too long: "${label.slice(0, 20)}..." (about 5 words)`;
    if (!TONES.includes(String(r.tone))) return `option tone must be good, bad or neutral`;
    if (out.some((p) => p.label.toLowerCase() === label.toLowerCase())) return `two options are both "${label}"`;
    out.push({ label, tone: r.tone as Tone });
  }
  return out;
}
export interface Check { id: number; project: string | null; team: string | null; agent: string; question: string; detail: string | null; createdBy: string; createdAt: number; state: CheckState; options: CheckOption[]; answer: string | null; answerTone: Tone | null; note: string | null; resolvedAt: number | null }
interface Row { id: number; project: string | null; team: string | null; agent: string; question: string; detail: string | null; created_by: string; created_at: number; state: string; note: string | null; resolved_at: number | null; options: string | null; answer: string | null; answer_tone: string | null }
export const QUESTION_MAX = 300, DETAIL_MAX = 2000, NOTE_MAX = 500, PENDING_CAP = 10;
/** A resolved check stays in the snapshot this long, so the page can show it green or red before it leaves. */
export const SHOW_RESOLVED_MS = 30_000;

const opts = (j: string | null): CheckOption[] => { try { const v = JSON.parse(j ?? ""); return Array.isArray(v) && v.length ? v : DEFAULT_OPTIONS; } catch { return DEFAULT_OPTIONS; } };
const toCheck = (r: Row): Check => ({ id: r.id, project: r.project, team: r.team, agent: r.agent, question: r.question, detail: r.detail, createdBy: r.created_by, createdAt: r.created_at, state: r.state === "pending" ? "pending" : "answered", options: opts(r.options), answer: r.answer, answerTone: r.answer_tone as Tone | null, note: r.note, resolvedAt: r.resolved_at });
const subs = new Set<(c: Check) => void>();
/** Every create and resolve, as the whole row (the stream's `check` frame). */
export function onCheck(fn: (c: Check) => void) { subs.add(fn); return () => subs.delete(fn); }

export function getCheck(id: number): Check | null { ensureSchema(); const r = db().query("SELECT * FROM checks WHERE id = ?").get(id) as Row | null; return r ? toCheck(r) : null; }
export function listChecks(state?: CheckState): Check[] {
  ensureSchema();
  const rows = (state ? db().query("SELECT * FROM checks WHERE state = ? ORDER BY id").all(state) : db().query("SELECT * FROM checks ORDER BY id").all()) as Row[];
  return rows.map(toCheck);
}
/** Pending ones plus the ones answered in the last 30 s: what the page draws. */
export function visibleChecks(now = Date.now()): Check[] {
  ensureSchema();
  return (db().query("SELECT * FROM checks WHERE state = 'pending' OR resolved_at > ? ORDER BY id").all(now - SHOW_RESOLVED_MS) as Row[]).map(toCheck);
}

export type CreateResult = { check: Check; created: boolean } | { error: string };
/** Same agent + same question while still pending = the existing row (an agent that asks twice does not stack chips). */
export function createCheck(i: { agent: string; question: unknown; detail?: unknown; options?: unknown; by: string; project?: string | null }, now = Date.now()): CreateResult {
  ensureSchema();
  const question = typeof i.question === "string" ? i.question.replace(/\s+/g, " ").trim() : "";
  if (!question) return { error: "question needed: what should the owner check, in plain words" };
  if (question.length > QUESTION_MAX) return { error: `question over ${QUESTION_MAX} characters` };
  const detail = typeof i.detail === "string" && i.detail.trim() ? i.detail.trim() : null;
  if (detail && detail.length > DETAIL_MAX) return { error: `detail over ${DETAIL_MAX} characters` };
  const options = parseOptions(i.options); if (typeof options === "string") return { error: options };
  const dup = db().query("SELECT * FROM checks WHERE agent = ? AND question = ? AND state = 'pending'").get(i.agent, question) as Row | null;
  if (dup) return { check: toCheck(dup), created: false };
  if ((db().query("SELECT COUNT(*) AS n FROM checks WHERE agent = ? AND state = 'pending'").get(i.agent) as { n: number }).n >= PENDING_CAP) return { error: `${i.agent} already has ${PENDING_CAP} checks waiting` };
  const team = teamsOf(i.agent)[0]?.id ?? null;
  const r = db().run("INSERT INTO checks (project, team, agent, question, detail, created_by, created_at, state, options) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)", [i.project ?? null, team, i.agent, question, detail, i.by, now, JSON.stringify(options)]);
  const check = getCheck(Number(r.lastInsertRowid))!;
  for (const f of subs) f(check);
  return { check, created: true };
}

export type ResolveResult = { check: Check } | { error: string; status: 404 | 409 | 422 };
/** `choice` is an option label (any case) or its 0-based index. The chosen label and tone are stored on the row. */
export function resolveCheck(id: number, choice: unknown, note: unknown, now = Date.now()): ResolveResult {
  ensureSchema();
  const n = typeof note === "string" && note.trim() ? note.trim() : null;
  if (n && n.length > NOTE_MAX) return { error: `note over ${NOTE_MAX} characters`, status: 422 };
  const cur = getCheck(id); if (!cur) return { error: `no check ${id}`, status: 404 };
  const opt = typeof choice === "number" ? cur.options[choice] : typeof choice === "string" ? cur.options.find((o) => o.label.toLowerCase() === choice.trim().toLowerCase()) : undefined;
  if (!opt) return { error: `option must be one of: ${cur.options.map((o) => o.label).join(", ")}`, status: 422 };
  if (cur.state !== "pending") return { error: `check ${id} is already answered`, status: 409 };
  db().run("UPDATE checks SET state = 'answered', answer = ?, answer_tone = ?, note = ?, resolved_at = ? WHERE id = ? AND state = 'pending'", [opt.label, opt.tone, n, now, id]);
  const check = getCheck(id)!;
  for (const f of subs) f(check);
  return { check };
}
