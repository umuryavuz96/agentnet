// Step 8b: Thompson line pick, line life cycle, graded memory, proposals (docs/internal/one-folder/SPEC-step8b-picks.md).
// Scratch home, in-memory DBs, seeded job_scores rows. Fixture names are made up.
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-lines8b-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../src/core/db");
const { tracing } = await import("../src/core/http");
type Env = import("../src/core/http").Env;
const st = await import("../src/net/store");
const rt = await import("../src/net/routes");
const sc = await import("../src/net/scores");
const ln = await import("../src/net/lines");

const app = new Hono<Env>(); app.use("*", tracing); const api = new Hono<Env>(); rt.agentnetRoutes(api); app.route("/api/v1", api);
const tok: Record<string, string> = {};
const call = (who: string, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/agentnet${path}`, { method, headers: { authorization: `Bearer ${tok[who] ?? who}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const j = async (p: Response | Promise<Response>) => { const r = await p; return { status: r.status, body: await r.json().catch(() => null) as any }; };

beforeAll(() => {
  useDatabase(new Database(":memory:")); st._reset();
  tok.root = rt.createAgent({ name: "root", job: "t", by: "test", standing: true }).token;
});
beforeEach(() => { sc.useScoreDb(new Database(":memory:")); });

/** Seeded random numbers (mulberry32), so a test run is the same every time. */
export const seeded = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
let jobN = 0;
/** One settled (graded, all steps verified) job of `line` per grade. */
export function seedJobs(line: string, grades: number[], verified = 3, t0 = 1_000_000) {
  for (const g of grades) {
    const n = ++jobN;
    sc.scoreDb().run("INSERT INTO job_scores (agent, agent_id, gen, role, job_id, opened_at, closed_at, outcome, steps, done, verified, grade, provisional) VALUES (?, ?, ?, ?, 1, ?, ?, 'done', 3, 3, ?, ?, 0)",
      [line, `${line}#${n}`, n, line.replace(/-\d+$/, ""), t0 + n, t0 + n + 1, verified, g]);
  }
}
let roleN = 0;
const freshRole = () => `pk${++roleN}x`;
const mkLine = (name: string) => { ln.ensureLine(name, "# fixture soul\n"); return name; };
const pickRows = () => sc.scoreDb().query("SELECT * FROM picks WHERE kind = 'line' ORDER BY id").all() as { role: string; chosen: string | null; prob: number | null; candidates_json: string }[];

test("pick: seeded rng, the better line wins most of 1000 picks", () => {
  const role = freshRole(), good = mkLine(`${role}-1`), weak = mkLine(`${role}-2`);
  seedJobs(good, [5, 5, 4, 5, 5, 5]); seedJobs(weak, [2, 3, 2, 2, 3, 2]);
  const rng = seeded(42), wins: Record<string, number> = {};
  for (let i = 0; i < 1000; i++) { const p = ln.pickLine(role, rng); if ("line" in p) wins[p.line] = (wins[p.line] ?? 0) + 1; }
  expect(wins[good]!).toBeGreaterThan(750); // rewards ~0.98 vs ~0.73 after 6 jobs: posteriors still overlap (834 with seed 42)
  expect((wins[good] ?? 0) + (wins[weak] ?? 0)).toBe(1000);
});
test("pick: fewer than 5 settled jobs falls back to rubric and logs prob null", () => {
  const role = freshRole(), a = mkLine(`${role}-1`), b = mkLine(`${role}-2`);
  seedJobs(a, [5, 5, 5, 5]); seedJobs(b, [4]);
  const p = ln.pickLine(role, seeded(1));
  expect(p).toMatchObject({ fallback: "rubric" });
  expect(p.candidates.map((c) => [c.line, c.n])).toEqual([[a, 4], [b, 1]]);
  const row = pickRows().at(-1)!;
  expect(row).toMatchObject({ role, chosen: null, prob: null });
});
test("pick: every pick writes a picks row with candidates and prob", async () => {
  const role = freshRole(), a = mkLine(`${role}-1`), b = mkLine(`${role}-2`);
  seedJobs(a, [5, 4, 5, 5, 4]); seedJobs(b, [3, 3, 4, 3, 3]);
  const before = pickRows().length;
  const p = ln.pickLine(role, seeded(7));
  expect("line" in p).toBe(true);
  const rows = pickRows(); expect(rows.length).toBe(before + 1);
  const row = rows.at(-1)!;
  expect(row.chosen).toBe((p as { line: string }).line);
  expect(row.prob).toBeGreaterThan(0); expect(row.prob).toBeLessThanOrEqual(1);
  expect(row.prob).toBe((p as { prob: number }).prob);
  const cj = JSON.parse(row.candidates_json) as { line: string; n: number; mean: number; p: number }[];
  expect(cj.map(({ line, n, mean }) => ({ line, n, mean }))).toEqual([{ line: a, n: 5, mean: 0.96 }, { line: b, n: 5, mean: 0.82 }]);
  expect(cj[0]!.p + cj[1]!.p).toBeCloseTo(1, 6);
  // the route: root only, same answer shape
  expect((await j(call(a, "POST", "/pick", { role }))).status).toBe(401);
  const r = await j(call("root", "POST", "/pick", { role }));
  expect(r.status).toBe(200); expect(typeof r.body.prob).toBe("number"); expect(r.body.candidates.length).toBe(2);
  expect(pickRows().length).toBe(before + 2);
  // a retired line is not a candidate
  const lj = ln.readLine(b)!; lj.status = "retired"; ln.writeLine(b, lj);
  expect(ln.pickLine(role, seeded(3)).candidates.map((c) => c.line)).toEqual([a]);
});

const told: string[] = [];
ln.setLineTell((t) => told.push(t));
/** One more job of `line`, then the life cycle. */
const job = (line: string, grade: number, verified = 3) => { seedJobs(line, [grade], verified); return ln.lifecycle(line)!; };

test("lifecycle: 3 below median gives probation, 2 more retire and fork the best line with parent", () => {
  const role = freshRole(), best = mkLine(`${role}-1`), weak = mkLine(`${role}-2`);
  seedJobs(best, Array(10).fill(5));
  ln.lifecycle(best); // first run: looks at the newest job only
  expect(job(weak, 2).status).toBe("active");
  expect(job(weak, 2).status).toBe("active");
  expect(job(weak, 2)).toEqual({ status: "probation", changed: true });
  expect(told.at(-1)).toContain(`line ${weak} on probation`);
  expect(job(weak, 2).status).toBe("probation");
  expect(job(weak, 2)).toEqual({ status: "retired", changed: true });
  const fork = `${role}-3`, fj = ln.readLine(fork)!;
  expect(fj).toMatchObject({ status: "active", parent: best, parentVersion: 1, current: 1, role });
  expect(readFileSync(join(ln.selfDir(fork, 1), "soul.md"), "utf8")).toContain("fixture soul");
  expect(told.at(-1)).toBe(`line ${weak} retired (2 more jobs below the role median 5 on probation); forked ${fork} from ${best}`);
  expect(ln.readLine(weak)!.history!.map((h) => h.to)).toEqual(["probation", "retired"]);
  expect(ln.lifecycle(weak)).toEqual({ status: "retired", changed: false }); // idempotent
});
test("lifecycle: probation ends at a job at or above the median", () => {
  const role = freshRole(), best = mkLine(`${role}-1`), weak = mkLine(`${role}-2`);
  seedJobs(best, Array(10).fill(5)); ln.lifecycle(best);
  for (let i = 0; i < 3; i++) job(weak, 2);
  expect(ln.readLine(weak)!.status).toBe("probation");
  expect(job(weak, 5)).toEqual({ status: "active", changed: true });
  expect(ln.readLine(weak)!.below).toBe(0);
  for (let i = 0; i < 2; i++) expect(job(weak, 2).status).toBe("active"); // the count starts again
});
test("lifecycle: 10 picks under 5% retires", () => {
  const role = freshRole(), best = mkLine(`${role}-1`), bad = mkLine(`${role}-2`);
  seedJobs(best, Array(10).fill(5)); seedJobs(bad, Array(10).fill(1), 0);
  const rng = seeded(5);
  for (let i = 0; i < 9; i++) { ln.pickLine(role, rng); expect(ln.readLine(bad)!.status).toBe("active"); }
  ln.pickLine(role, rng);
  expect(ln.readLine(bad)!.status).toBe("retired");
  expect(ln.readLine(`${role}-3`)).toMatchObject({ parent: best });
  expect(ln.pickLine(role, rng).candidates.map((c) => c.line).sort()).toEqual([best, `${role}-3`]);
});
test("lifecycle: retire never touches a live agent row", async () => {
  const role = freshRole(), name = `${role}-1`;
  const made = rt.createAgent({ name, boss: "root", job: "t", goal: "g", by: "test" }); tok[name] = made.token;
  await call(name, "POST", "/hello", { session: `s-${made.id}`, pid: 61_001 });
  const rowBefore = JSON.stringify(rt.byName(name)), lifeBefore = st.get(made.id)!.life;
  expect((await j(call(name, "POST", `/agent-lines/${name}/retire`, { reason: "x" }))).status).toBe(403);
  const r = await j(call("root", "POST", `/agent-lines/${name}/retire`, { reason: "test" }));
  expect(r.status).toBe(200); expect(r.body.line.status).toBe("retired"); expect(r.body.forked).toBeNull();
  expect(JSON.stringify(rt.byName(name))).toBe(rowBefore);
  expect(st.get(made.id)!.life).toBe(lifeBefore);
  expect((await j(call("root", "POST", `/agent-lines/${name}/activate`, {}))).body.line.status).toBe("active");
  const f = await j(call("root", "POST", `/agent-lines/${name}/fork`, {}));
  expect(f.status).toBe(201); expect(f.body).toMatchObject({ line: `${role}-2`, parent: name, parentVersion: 1 });
  expect((await j(call("root", "POST", `/agent-lines/${name}/fork`, { as: `${role}-2` }))).status).toBe(409);
});

// ---------- graded memory ----------
const tl = await import("../src/net/trails");
tl.useTrailDb(new Database(":memory:"));
const noteMeta = (agentId: string) => tl.search("zebrafinch quokka", { limit: 10, max: 10 }).filter((h) => h.agentId === agentId);
test("trails: settled job's notes carry reward; regrade updates it", async () => {
  const name = `${freshRole()}-1`, made = rt.createAgent({ name, boss: "root", job: "t", goal: "g", by: "test" }); tok[name] = made.token;
  await call(name, "POST", "/hello", { session: `s-${made.id}`, pid: 61_100 });
  rt.startJob(made.id, { by: "root", goal: "fixture job", steps: ["outcome 1", "outcome 2"] });
  expect((await call(name, "POST", "/steps/done", { evidence: ["check: bun test 3 pass 0 fail"], goal: "zebrafinch quokka parser", decisions: [{ chosen: "zebrafinch quokka tokens", why: "fixture" }] })).status).toBe(200);
  expect(noteMeta(made.id).map((h) => [h.job, h.reward])).toEqual([[1, null]]);
  const gen = Number(made.id.split("#")[1]);
  sc.scoreDb().run("INSERT INTO job_scores (agent, agent_id, gen, role, job_id, opened_at, closed_at, outcome, steps, done, verified, grade, provisional) VALUES (?, ?, ?, 'x', 1, 1, 2, 'done', 2, 2, 2, 4, 1)", [name, made.id, gen]);
  expect(ln.noteReward(name, gen, 1)).toBe(1);
  expect(noteMeta(made.id)[0]!.reward).toBe(4.75); // provisional: 0.75 x 5 + 0.25 x 4
  sc.scoreDb().run("UPDATE job_scores SET grade = 1, provisional = 0 WHERE agent_id = ?", [made.id]); // root regrades
  ln.noteReward(name, gen, 1);
  expect(noteMeta(made.id)[0]!.reward).toBe(3);
  // the agent's current job's notes are never injected back to it; an earlier job's notes still show
  const own = await tl.inject(name, "task_add", "zebrafinch quokka parser tokens", undefined, tl.noResolver, undefined, 0, { agentId: made.id, job: 1 });
  expect(own.hits.some((h) => h.agentId === made.id)).toBe(false);
  const later = await tl.inject(name, "task_add", "zebrafinch quokka parser tokens", undefined, tl.noResolver, undefined, 0, { agentId: made.id, job: 2 });
  expect(later.hits.some((h) => h.agentId === made.id && h.job === 1)).toBe(true);
});
test("trails: high-reward note outranks equal-text low-reward note; low ones are labeled avoid", async () => {
  const text = { goal: "wombatcache eviction for lru lists", decisions: [{ chosen: "wombatcache two-queue eviction", why: "fixture" }], result: "wombatcache done" };
  tl.writeNote({ agent: "low-1", task: "wombatcache eviction", repo: null, agentId: "low-1#1", job: 1 }, text);
  tl.writeNote({ agent: "high-1", task: "wombatcache eviction", repo: null, agentId: "high-1#1", job: 1 }, text);
  const before = tl.search("wombatcache eviction", { limit: 2 });
  expect(before.length).toBe(2);
  tl.setNoteReward("low-1#1", 1, 1); tl.setNoteReward("high-1#1", 1, 5);
  const hits = tl.search("wombatcache eviction", { limit: 2 });
  expect(hits.map((h) => h.agentId)).toEqual(["high-1#1", "low-1#1"]);
  expect(hits[0]!.score).toBeLessThan(hits[1]!.score);
  expect(hits[0]!.snippet.startsWith("avoid:")).toBe(false);
  expect(hits[1]!.snippet.startsWith("avoid: ")).toBe(true);
  expect(tl.format(hits)).toContain("> avoid: ");
  // swap the rewards: the order follows the reward, not the write order
  tl.setNoteReward("low-1#1", 1, 5); tl.setNoteReward("high-1#1", 1, 1);
  expect(tl.search("wombatcache eviction", { limit: 2 }).map((h) => h.agentId)).toEqual(["low-1#1", "high-1#1"]);
  expect([tl.rewardFactor(5), tl.rewardFactor(1), tl.rewardFactor(3), tl.rewardFactor(null)]).toEqual([1.3, 0.7, 1, 1]);
});

// ---------- proposals ----------
const { baseDir } = await import("../src/net/agent-config");
const { existsSync: has } = await import("node:fs");
/** A live agent on its own line with lines on; `rewardGrade` seeds one earlier settled job of the line. */
async function lineAgent(rewardGrade: number | null) {
  const name = `${freshRole()}-1`, made = rt.createAgent({ name, boss: "root", job: "t", goal: "g", by: "test" }); tok[name] = made.token;
  await call(name, "POST", "/hello", { session: `s-${made.id}`, pid: 61_200 + roleN });
  if (rewardGrade != null) seedJobs(name, [rewardGrade]);
  return { name, id: made.id };
}
const SKILL = { name: "fixture-loop", summary: "Run the fixture loop before each step.", files: [{ path: "SKILL.md", content: "# Fixture loop\nRun it.\n" }, { path: "scripts/run.sh", content: "echo run\n" }] };
test("proposals: approve with a missing proposal file writes nothing and can be retried", async () => {
  process.env.AGENTNET_LINES = "1";
  try {
    const a = await lineAgent(4);
    const r = await j(call(a.name, "POST", "/propose-skill", { ...SKILL, name: "fixture-gone" }));
    expect(r.status).toBe(201);
    const pdir = join((await import("../src/core/config")).ROOT, "lines", a.name, "proposals", r.body.id, "files");
    rmSync(join(pdir, "scripts", "run.sh"));
    const lj = ln.readLine(a.name)!, dst = join(ln.selfDir(a.name, lj.current), "skills", "fixture-gone");
    expect((await j(call("root", "POST", `/agent-lines/proposals/${r.body.id}/approve`, { into: "line" }))).status).toBe(422);
    expect(has(dst)).toBe(false); // no half-made dir that would block the retry with 409
    mkdirSync(join(pdir, "scripts"), { recursive: true }); writeFileSync(join(pdir, "scripts", "run.sh"), "echo run\n");
    expect((await j(call("root", "POST", `/agent-lines/proposals/${r.body.id}/approve`, { into: "line" }))).status).toBe(200);
    expect(readFileSync(join(dst, "scripts", "run.sh"), "utf8")).toBe("echo run\n");
  } finally { delete process.env.AGENTNET_LINES; }
});
test("proposals: skill from a reward 4 job is stored and needs root approve", async () => {
  process.env.AGENTNET_LINES = "1";
  try {
    const a = await lineAgent(4);
    const r = await j(call(a.name, "POST", "/propose-skill", SKILL));
    expect(r.status).toBe(201); expect(r.body).toEqual({ id: r.body.id, state: "accepted for review" });
    expect(JSON.stringify(r.body)).not.toMatch(/reward|grade/);
    expect(told.at(-1)).toContain(`${a.name} proposed skill "fixture-loop"`);
    const lj = ln.readLine(a.name)!, dst = join(ln.selfDir(a.name, lj.current), "skills", "fixture-loop");
    expect(has(dst)).toBe(false); // nothing lands before root says yes
    expect((await j(call(a.name, "GET", "/agent-lines/proposals"))).status).toBe(403);
    expect((await j(call(a.name, "POST", `/agent-lines/proposals/${r.body.id}/approve`, { into: "line" }))).status).toBe(403);
    const list = await j(call("root", "GET", "/agent-lines/proposals?status=pending"));
    expect(list.body.proposals.find((p: { id: string }) => p.id === r.body.id)).toMatchObject({ kind: "skill", line: a.name, status: "pending", files: [{ path: "SKILL.md" }, { path: "scripts/run.sh" }] });
    const ok = await j(call("root", "POST", `/agent-lines/proposals/${r.body.id}/approve`, { into: "line" }));
    expect(ok.status).toBe(200); expect(ok.body.proposal).toMatchObject({ status: "approved", into: "line" });
    expect(readFileSync(join(dst, "scripts", "run.sh"), "utf8")).toBe("echo run\n");
    expect((await j(call("root", "POST", `/agent-lines/proposals/${r.body.id}/approve`, { into: "line" }))).status).toBe(409); // once
    // a bad path and an oversize skill are refused before anything is stored
    expect((await j(call(a.name, "POST", "/propose-skill", { ...SKILL, files: [{ path: "../x.md", content: "x" }] }))).status).toBe(422);
    expect((await j(call(a.name, "POST", "/propose-skill", { ...SKILL, files: [{ path: "big.md", content: "x".repeat(65 * 1024) }] }))).status).toBe(422);
    // into base, then reject
    const r2 = await j(call(a.name, "POST", "/propose-skill", { ...SKILL, name: "fixture-two" }));
    const b2 = await j(call("root", "POST", `/agent-lines/proposals/${r2.body.id}/approve`, { into: "base" }));
    expect(b2.status).toBe(200); expect(has(join(baseDir(), "skills", "fixture-two", "SKILL.md"))).toBe(true);
    const r3 = await j(call(a.name, "POST", "/propose-skill", { ...SKILL, name: "fixture-three" }));
    expect((await j(call("root", "POST", `/agent-lines/proposals/${r3.body.id}/reject`, {}))).status).toBe(422);
    expect((await j(call("root", "POST", `/agent-lines/proposals/${r3.body.id}/reject`, { reason: "duplicate" }))).body.proposal).toMatchObject({ status: "rejected", reason: "duplicate" });
  } finally { delete process.env.AGENTNET_LINES; }
});
test("proposals: low-reward job is not eligible", async () => {
  process.env.AGENTNET_LINES = "1";
  try {
    const low = await lineAgent(1), none = await lineAgent(null);
    for (const a of [low, none]) {
      const r = await j(call(a.name, "POST", "/propose-skill", SKILL));
      expect(r.status).toBe(409); expect(r.body.detail).toBe("agentnet: not eligible now");
    }
    expect((await j(call("root", "GET", "/agent-lines/proposals"))).body.proposals.filter((p: { line: string }) => p.line === low.name || p.line === none.name)).toEqual([]);
  } finally { delete process.env.AGENTNET_LINES; }
  const off = await lineAgent(5); // lines off: the tools are refused
  expect((await j(call(off.name, "POST", "/propose-skill", SKILL))).status).toBe(409);
});
test("proposals: house rule is owner-only and never written by approve without the owner flag", async () => {
  process.env.AGENTNET_LINES = "1";
  try {
    const a = await lineAgent(null); // rules need no reward
    const house = await j(call(a.name, "POST", "/propose-rule", { text: "Every agent runs the full test suite before any commit.", target: "house" }));
    expect(house.status).toBe(201); expect(house.body.ownerOnly).toBe(true);
    expect(told.at(-1)).toContain("HOUSE rule");
    const refused = await j(call("root", "POST", `/agent-lines/proposals/${house.body.id}/approve`, {}));
    expect(refused.status).toBe(409); expect(refused.body.detail).toContain("owner-only");
    const rulesDir = join(baseDir(), "rules"), before = has(rulesDir);
    const ok = await j(call("root", "POST", `/agent-lines/proposals/${house.body.id}/approve`, { owner: true }));
    expect(ok.body.proposal).toMatchObject({ status: "approved", ownerApproved: true, applied: null });
    expect(has(rulesDir)).toBe(before); // nothing written to claude/base/rules
    // a line rule lands in the current rules.md
    const line = await j(call(a.name, "POST", "/propose-rule", { text: "Run ui-check before every UI step closes.", target: "line" }));
    expect(line.body.ownerOnly).toBe(false);
    await j(call("root", "POST", `/agent-lines/proposals/${line.body.id}/approve`, {}));
    const lj = ln.readLine(a.name)!;
    expect(readFileSync(join(ln.selfDir(a.name, lj.current), "rules.md"), "utf8")).toBe("Run ui-check before every UI step closes.\n");
    expect((await j(call(a.name, "POST", "/propose-rule", { text: "short", target: "line" }))).status).toBe(422);
  } finally { delete process.env.AGENTNET_LINES; }
});

// ---------- read routes ----------
const { requireAuth, rootOnly } = await import("../src/core/access");
const { isPanelWrite } = await import("../src/net/mount");
const { linesPanelRoutes } = await import("../src/net/linesView");
const papp = new Hono<Env>(); papp.use("*", tracing);
const papi = new Hono<Env>(); papi.use("*", requireAuth(rt.agentPath)); papi.use("*", (c, next) => (isPanelWrite(c.req.method, c.req.path) ? rootOnly(c, next) : next()));
linesPanelRoutes(papi); papp.route("/api/v1", papi);
const panel = (who: string, method: string, path: string, body?: unknown) =>
  j(papp.request(`/api/v1/agentnet-panel${path}`, { method, headers: { authorization: `Bearer ${tok[who] ?? who}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));
test("read routes: list and detail for root; an agent token gets 403 on root fields", async () => {
  process.env.AGENTNET_LINES = "1";
  try {
    const a = await lineAgent(null), role = a.name.replace(/-\d+$/, ""), b = mkLine(`${role}-2`);
    seedJobs(a.name, [5, 5, 4, 5, 5]); seedJobs(b, [3, 2, 3, 3, 2]);
    ln.pickLine(role, seeded(7));
    const pr = await j(call(a.name, "POST", "/propose-rule", { text: "Paste the check line into every step proof.", target: "line" }));
    expect(pr.status).toBe(201);
    // bearer (root): list and detail
    const list = await j(call("root", "GET", "/agent-lines"));
    expect(list.status).toBe(200);
    const row = list.body.lines.find((r: { line: string }) => r.line === a.name);
    expect(row).toMatchObject({ role, status: "active", jobs: 5, lastReward: expect.any(Number) });
    expect(row.lastPick == null || typeof row.lastPick === "number").toBe(true);
    expect((await j(call(a.name, "GET", "/agent-lines"))).status).toBe(403);
    const d = await j(call("root", "GET", `/agent-lines/${a.name}`));
    expect(d.body.baselineSeries).toHaveLength(5); expect(d.body.baselineSeries[0]).toMatchObject({ gen: expect.any(Number), baseline: expect.any(Number) });
    expect(d.body.picks[0].candidates.map((c: { line: string }) => c.line).sort()).toEqual([a.name, b].sort());
    expect(d.body.proposals[0]).toMatchObject({ id: pr.body.id, kind: "rule" });
    // panel: root sees proposals; an agent token reads the list and a trimmed detail, 403 on root fields
    expect((await panel("root", "GET", "/lines")).body.lines.some((r: { line: string }) => r.line === b)).toBe(true);
    expect((await panel("root", "GET", `/lines/${a.name}`)).body).toMatchObject({ root: true, proposals: [{ id: pr.body.id }] });
    const ag = await panel(a.name, "GET", `/lines/${a.name}`);
    expect(ag.status).toBe(200); expect(ag.body.root).toBe(false); expect(ag.body.proposals).toBeUndefined();
    expect((await panel(a.name, "GET", `/lines/${a.name}?include=root`)).status).toBe(403);
    expect((await panel(a.name, "GET", "/lines/proposals")).status).toBe(403);
    expect((await panel(a.name, "POST", `/lines/proposals/${pr.body.id}/approve`, {})).status).toBe(403);
    expect((await panel("root", "GET", "/lines/proposals?status=pending")).body.proposals.some((p: { id: string }) => p.id === pr.body.id)).toBe(true);
    expect((await panel("root", "POST", `/lines/proposals/${pr.body.id}/approve`, {})).body.proposal).toMatchObject({ status: "approved" });
    expect((await panel("root", "GET", "/lines/no-such-line")).status).toBe(404);
  } finally { delete process.env.AGENTNET_LINES; }
});
test("read routes: the panel list says whether lines are on (AGENTNET_LINES)", async () => {
  delete process.env.AGENTNET_LINES;
  expect((await panel("root", "GET", "/lines")).body.on).toBe(false);
  process.env.AGENTNET_LINES = "1";
  try { expect((await panel("root", "GET", "/lines")).body.on).toBe(true); } finally { delete process.env.AGENTNET_LINES; }
});
