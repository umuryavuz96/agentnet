// What a reference chip points at (docs/CHAT-TEXT-MARKERS.md). A commit or pull request is asked from the service
// (src/net/chatRefs.ts) and kept for 60 s; a message, step or job is looked up in what the chat already has.
import type { Job } from "./net";
import type { ChipTone } from "./chatMarkers";
import type { FeedItem } from "./chatFeed";

export type LookKind = "sha" | "pr";
export interface RefFile { path: string; add: number | null; del: number | null }
export interface CommitRef { sha: string; short: string; subject: string; body: string; author: string; date: string; branches: string[]; files: RefFile[]; filesChanged: number; insertions: number; deletions: number; pushed: boolean; hasRemote: boolean }
export interface PrRef { number: number; title: string; state: "open" | "merged" | "closed" | "draft"; author: string; branch: string; base: string; url: string; checks: { total: number; passed: number; failed: number; pending: number; skipped: number } }
export type RefAnswer =
  | { available: true; kind: "sha"; id: string; /** folder name of the repository it was found in */ repo?: string; commit: CommitRef }
  | { available: true; kind: "pr"; id: string; repo?: string; pr: PrRef }
  | { available: false; kind: LookKind; id: string; reason: string };

const KEEP_MS = 60_000;
const cache = new Map<string, { at: number; ask: Promise<RefAnswer>; got?: RefAnswer }>();
const keyOf = (agent: string, kind: LookKind, id: string) => `${agent}\n${kind}\n${id}`;
/** The answer already here, or undefined: lets a click open a pull request without waiting. */
export function knownRef(agent: string, kind: LookKind, id: string): RefAnswer | undefined {
  const hit = cache.get(keyOf(agent, kind, id));
  return hit && Date.now() - hit.at < KEEP_MS ? hit.got : undefined;
}
/** `get` is the page's api(). Never rejects: a request that fails is a "not available" answer, and is asked again next time. */
export function loadRef(agent: string, kind: LookKind, id: string, get: (path: string) => Promise<RefAnswer>): Promise<RefAnswer> {
  const key = keyOf(agent, kind, id), hit = cache.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.ask;
  const entry: { at: number; ask: Promise<RefAnswer>; got?: RefAnswer } = { at: Date.now(), ask: null as unknown as Promise<RefAnswer> };
  entry.ask = get(`v1/panel/agents/${encodeURIComponent(agent)}/ref?kind=${kind}&id=${encodeURIComponent(id)}`).then(
    (a) => (entry.got = a),
    (e: Error): RefAnswer => { cache.delete(key); return { available: false, kind, id, reason: /no such route|not found/i.test(e.message) ? "The agentnet service is older than this page. Restart it to read git details." : "The agentnet service did not answer" }; },
  );
  cache.set(key, entry);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return entry.ask;
}

export interface StateChip { tone: ChipTone; text: string }
/** The state chips of a card, in the tone chip colours. */
export function stateChips(a: RefAnswer): StateChip[] {
  if (!a.available) return [];
  if (a.kind === "sha") return [a.commit.pushed ? { tone: "ok", text: "pushed" } : { tone: "warn", text: a.commit.hasRemote ? "not pushed" : "local only" }];
  const tone = ({ merged: "ok", open: "info", draft: "warn", closed: "bad" } as const)[a.pr.state];
  const failed = a.pr.checks.failed;
  return [{ tone, text: a.pr.state }, ...(failed ? [{ tone: "bad" as const, text: `${failed} ${failed === 1 ? "check" : "checks"} failed` }] : [])];
}
export function checksLine(c: PrRef["checks"]): string {
  if (!c.total) return "No checks";
  return [[c.passed, "passed"], [c.failed, "failed"], [c.pending, "running"], [c.skipped, "skipped"]].filter(([n]) => n).map(([n, w]) => `${n} ${w}`).join(" · ");
}

/** The job, and the step when one is named, behind `job 14`, `step 1.2` or `step 3` (a step of the current job). */
export function planTarget(jobs: readonly Job[] | undefined, kind: "step" | "job", id: string): { job: number; step: number | null } | null {
  const [a, b] = id.split(".").map(Number) as [number, number | undefined];
  const job = kind === "job" || b != null ? jobs?.find((j) => j.id === a) : jobs?.at(-1);
  if (!job) return null;
  if (kind === "job") return { job: job.id, step: null };
  const n = b ?? a;
  return !job.legacy && job.steps.some((s) => s.n === n) ? { job: job.id, step: n } : null;
}

/** The trail row of message `id` among the chat's work runs: the run's key and the row's id. */
export function messageTarget(works: readonly { key: string; items: readonly FeedItem[] }[], id: number): { key: string; item: string } | null {
  for (const w of works) { const it = w.items.find((i) => i.msg === id); if (it) return { key: w.key, item: it.id }; }
  return null;
}
