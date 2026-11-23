import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOP, fetchAsRoot } from "./helpers";

// No tool answer may flood an agent's context: list_agents, owner_goals, list_checks, get_status page or shrink, inbox is capped by bytes, the plugin guards 60 KB.
process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-paging-"));
const { buildApp, makeFetch } = await import("../src/server");
{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../src/core/db"); useDatabase(new Database(":memory:")); (await import("../src/net/store"))._reset(); }
const f = await fetchAsRoot(makeFetch(buildApp()));
const call = (path: string, body?: unknown, token?: string) => f(new Request(`http://x${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), LOOP);
const json = async <T>(r: Response) => (await r.json()) as T;
type Row = { name: string; spawnedAt: number; life: string; boss: string | null; tasks?: unknown; jobs?: unknown };
type Page = { total: number; next_cursor: string | null; agents: Row[] };
const NAMES = ["pg-1", "pg-2", "pg-3", "pg-4", "pg-5", "pg-6", "pg-7"];
const tokens: Record<string, string> = {};
for (const [i, name] of NAMES.entries()) {
  const r = await call("/v1/admin/spawn", { name, job: "paging test", goal: "paging test is done", boss: i < 4 ? "root" : "pg-1" });
  expect(r.status).toBe(201); tokens[name] = (await Bun.file((await json<{ token_file: string }>(r)).token_file).text()).trim();
}

test("list_agents compact: first page, next page, end; newest first, no overlap", async () => {
  const p1 = await json<Page>(await call("/v1/agent/agents?compact=1&limit=3"));
  expect(p1.agents.length).toBe(3); expect(p1.total).toBe(7); expect(p1.next_cursor).toBeTruthy();
  const p2 = await json<Page>(await call(`/v1/agent/agents?compact=1&limit=3&cursor=${encodeURIComponent(p1.next_cursor!)}`));
  expect(p2.agents.length).toBe(3); expect(p2.total).toBe(7); expect(p2.next_cursor).toBeTruthy();
  const p3 = await json<Page>(await call(`/v1/agent/agents?compact=1&limit=3&cursor=${encodeURIComponent(p2.next_cursor!)}`));
  expect(p3.agents.length).toBe(1); expect(p3.next_cursor).toBeNull();
  const seen = [...p1.agents, ...p2.agents, ...p3.agents].map((a) => a.name);
  expect(new Set(seen).size).toBe(7); expect(seen.sort()).toEqual(NAMES);
  const at = [...p1.agents, ...p2.agents, ...p3.agents].map((a) => a.spawnedAt); expect(at).toEqual([...at].sort((a, b) => b - a));
});

test("list_agents compact: the row is small, the default answer is unchanged", async () => {
  const p = await json<Page>(await call("/v1/agent/agents?compact=1"));
  expect(p.agents.length).toBe(7); expect(p.next_cursor).toBeNull();
  expect(p.agents[0]).not.toHaveProperty("tasks"); expect(p.agents[0]).not.toHaveProperty("jobs");
  expect(Object.keys(p.agents[0]!)).toEqual(expect.arrayContaining(["id", "name", "life", "state", "model", "boss", "project", "goal", "progress", "cost", "contextPct", "lastMsgAt", "step"]));
  expect(JSON.stringify(p.agents[0]).length).toBeLessThan(800);
  const full = await json<{ agents: Row[]; total?: number }>(await call("/v1/agent/agents"));
  expect(full.agents.length).toBe(7); expect(full.total).toBeUndefined(); expect(full.agents[0]).toHaveProperty("tasks");
});

test("list_agents compact: limit is clamped, filters boss and since, bad life is 422", async () => {
  expect((await json<Page>(await call("/v1/agent/agents?compact=1&limit=0"))).agents.length).toBe(1);
  expect((await json<Page>(await call("/v1/agent/agents?compact=1&limit=9999"))).agents.length).toBe(7);
  const kids = await json<Page>(await call("/v1/agent/agents?compact=1&boss=pg-1"));
  expect(kids.total).toBe(3); expect(kids.agents.every((a) => a.boss === "pg-1")).toBe(true);
  const newest = (await json<Page>(await call("/v1/agent/agents?compact=1&limit=1"))).agents[0]!.spawnedAt;
  expect((await json<Page>(await call(`/v1/agent/agents?compact=1&since=${newest}`))).agents.every((a) => a.spawnedAt >= newest)).toBe(true);
  expect((await json<Page>(await call(`/v1/agent/agents?compact=1&since=${newest + 1}`))).total).toBe(0);
  expect((await call("/v1/agent/agents?compact=1&life=nope")).status).toBe(422);
});

test("list_agents compact: gone agents need all or life=gone", async () => {
  expect((await call("/v1/admin/despawn", { agent: "pg-7" })).status).toBe(200);
  expect((await json<Page>(await call("/v1/agent/agents?compact=1"))).total).toBe(6);
  const all = await json<Page>(await call("/v1/agent/agents?compact=1&all=1"));
  expect(all.total).toBe(7); expect(all.agents.find((a) => a.name === "pg-7")?.life).toBe("gone");
  const gone = await json<Page>(await call("/v1/agent/agents?compact=1&life=gone"));
  expect(gone.agents.map((a) => a.name)).toEqual(["pg-7"]);
});

test("get_status compact: evidence of earlier jobs is dropped unless jobs=all", async () => {
  const step = (n: number) => ({ n, text: `s${n}`, origin: "brief", originMsg: null, status: "done", evidence: [{ kind: "commit", value: "abc1234", ok: true }], addedAt: 1 });
  const job = (id: number, closed: boolean) => ({ id, goal: "g", brief: null, openedBy: "root", openedAt: 1, closedAt: closed ? 2 : null, outcome: closed ? "done" : null, plan: 1, steps: [step(1)] });
  const { compactStatus } = await import("../src/net/routes");
  const snap = { ...(await import("../src/net/store")).get(`${NAMES[0]}#1`) ?? (await import("../src/net/store")).live()[0]! } as import("../src/net/store").Snapshot;
  snap.jobs = [job(1, true), job(2, false)] as never;
  const slim = compactStatus(snap, false).jobs as { steps: { evidence: unknown[]; evidenceCount?: number }[] }[];
  expect(slim[0]!.steps[0]!.evidence).toEqual([]); expect(slim[0]!.steps[0]!.evidenceCount).toBe(1); expect(slim[1]!.steps[0]!.evidence.length).toBe(1);
  expect((compactStatus(snap, true).jobs as { steps: { evidence: unknown[] }[] }[])[0]!.steps[0]!.evidence.length).toBe(1);
  const r = await json<{ agent: { name: string }; events: unknown[] }>(await call("/v1/agent/agents/pg-2?compact=1&events=500"));
  expect(r.agent.name).toBe("pg-2"); expect(r.events.length).toBeLessThanOrEqual(50);
});

test("list_checks compact pages newest first and cuts long text", async () => {
  for (let i = 1; i <= 5; i++) expect((await call("/v1/agent/checks", { agent: "pg-1", question: `Q${i}`, detail: "d".repeat(2000) })).status).toBe(201);
  type C = { total: number; next_cursor: string | null; checks: { question: string; detail: string }[] };
  const a = await json<C>(await call("/v1/agent/checks?compact=1&limit=2"));
  expect(a.total).toBe(5); expect(a.checks.map((c) => c.question)).toEqual(["Q5", "Q4"]); expect(a.checks[0]!.detail.length).toBeLessThan(700); expect(a.checks[0]!.detail).toContain("…[+1400 chars]");
  const b = await json<C>(await call(`/v1/agent/checks?compact=1&limit=2&cursor=${encodeURIComponent(a.next_cursor!)}`));
  expect(b.checks.map((c) => c.question)).toEqual(["Q3", "Q2"]);
  const c = await json<C>(await call(`/v1/agent/checks?compact=1&limit=2&cursor=${encodeURIComponent(b.next_cursor!)}`));
  expect(c.checks.map((x) => x.question)).toEqual(["Q1"]); expect(c.next_cursor).toBeNull();
  expect((await json<{ checks: unknown[] }>(await call("/v1/agent/checks"))).checks.length).toBe(5); // no compact: as before
});

test("owner_goals compact pages newest first; goal=N is whole", async () => {
  const { db } = await import("../src/core/db"), { goalsView } = await import("../src/net/ownerAsks");
  goalsView(); // makes the tables
  for (let i = 1; i <= 12; i++) db().run("INSERT INTO owner_goals (source, msg_id, text, status, created_at, updated_at) VALUES ('tg', ?, ?, 'doing', ?, ?)", [`m${i}`, `goal ${i} ` + "x".repeat(900), Date.now(), Date.now()]);
  type G = { total: number; next_cursor: string | null; goals: { id: number; text: string }[] };
  const a = await json<G>(await call("/api/v1/agentnet/owner-goals?compact=1"));
  expect(a.goals.length).toBe(8); expect(a.total).toBe(12); expect(a.goals[0]!.text.length).toBeLessThan(300); expect(a.goals[0]!.id).toBeGreaterThan(a.goals[1]!.id);
  const b = await json<G>(await call(`/api/v1/agentnet/owner-goals?compact=1&cursor=${encodeURIComponent(a.next_cursor!)}`));
  expect(b.goals.length).toBe(4); expect(b.next_cursor).toBeNull();
  const one = await json<G>(await call(`/api/v1/agentnet/owner-goals?compact=1&goal=${a.goals[0]!.id}`));
  expect(one.goals[0]!.text.length).toBeGreaterThan(900);
  expect((await json<{ goals: unknown[] }>(await call("/api/v1/agentnet/owner-goals"))).goals.length).toBe(12); // no compact: as before
});

test("inbox answers at most 40 KB of bodies; the rest stays unread for the next call", async () => {
  for (let i = 1; i <= 4; i++) expect((await call("/v1/agent/send", { to: "root", subject: `m${i}`, body: "b".repeat(15_000) }, tokens["pg-2"])).status).toBe(200);
  type In = { messages: { subject: string }[]; unread_left: number };
  const a = await json<In>(await call("/v1/agent/inbox", {}));
  expect(a.messages.map((m) => m.subject)).toEqual(["m1", "m2"]); expect(a.unread_left).toBe(2);
  const b = await json<In>(await call("/v1/agent/inbox", {}));
  expect(b.messages.map((m) => m.subject)).toEqual(["m3", "m4"]); expect(b.unread_left).toBe(0);
});

test("plugin guard: an answer over 60 KB becomes a notice with how to page; inbox is never cut", async () => {
  const { guardAnswer, ANSWER_MAX } = await import(`../plugin/hooks/register.ts?p=${Date.now()}`) as { guardAnswer: (t: string, x: string) => string; ANSWER_MAX: number }; // a computed path: the plugin has its own tsconfig
  const small = JSON.stringify({ a: 1 });
  expect(guardAnswer("list_agents", small)).toBe(small);
  const big = JSON.stringify({ x: "y".repeat(ANSWER_MAX) });
  const n = JSON.parse(guardAnswer("list_agents", big)) as { truncated: boolean; bytes: number; limit: number; hint: string };
  expect(n.truncated).toBe(true); expect(n.bytes).toBe(new TextEncoder().encode(big).length); expect(n.limit).toBe(ANSWER_MAX); expect(n.hint).toContain("cursor"); expect(guardAnswer("list_agents", big).length).toBeLessThan(500);
  expect(JSON.parse(guardAnswer("anything", big)).hint).toContain("limit");
  expect(guardAnswer("inbox", big)).toBe(big);
});
