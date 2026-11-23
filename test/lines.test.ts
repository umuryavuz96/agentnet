// Step 8a: the line store, upgrades, the gate and keep/revert (docs/internal/one-folder/SPEC-step8-lines.md, job 8a).
// Scratch home, in-memory DBs, stubbed processes (no real process is listed or signalled). Fixture names are made up.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-lines-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { db, useDatabase } = await import("../src/core/db");
const { tracing } = await import("../src/core/http");
type Env = import("../src/core/http").Env;
const st = await import("../src/net/store");
const rt = await import("../src/net/routes");
const sc = await import("../src/net/scores");
const fin = await import("../src/net/finish");
const ln = await import("../src/net/lines");
const { denyRules } = await import("../src/net/agent-config");
const { soulsDir } = await import("../src/core/layout");
const tr = await import("./helpers/transcript");
type FixtureCall = import("./helpers/transcript").FixtureCall;

const app = new Hono<Env>(); app.use("*", tracing); const api = new Hono<Env>(); rt.agentnetRoutes(api); app.route("/api/v1", api);
const tok: Record<string, string> = {};
const call = (who: string, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/agentnet${path}`, { method, headers: { authorization: `Bearer ${tok[who] ?? who}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const j = async (p: Response | Promise<Response>) => { const r = await p; return { status: r.status, body: await r.json().catch(() => null) as any }; };
fin.finishDeps.procs = { table: () => [], panePids: () => [], portPids: () => [], signal: () => {}, alive: () => true, later: (fn) => fn(), killSession: () => {} };

const on = () => { process.env.AGENTNET_LINES = "1"; };
const off = () => { delete process.env.AGENTNET_LINES; };
beforeAll(async () => {
  useDatabase(new Database(":memory:")); st._reset(); sc.useScoreDb(new Database(":memory:"));
  tok.root = rt.createAgent({ name: "root", job: "t", by: "test", standing: true }).token;
  await ln.registerLineHandlers();
});
const CH = tr.scratchClaudeHome(), CWD = "/fixture/lines-work";
afterAll(() => { off(); CH.restore(); });
const sessionOf: Record<string, string> = {};
const fileOf = (name: string) => tr.transcriptPath(CH.home, CWD, sessionOf[name]!);

/** A live gen of `name` with a job of `steps` steps. */
async function spawn(name: string, steps = 2, soul?: string) {
  const made = rt.createAgent({ name, boss: "root", job: "t", goal: "g", by: "test", soul, project: CWD }, Date.now() - 60_000);
  tok[name] = made.token; sessionOf[name] = `s-${made.id}`;
  await call(name, "POST", "/hello", { session: `s-${made.id}`, pid: 50_000 + made.id.length });
  rt.startJob(made.id, { by: "root", goal: "fixture job", steps: Array.from({ length: steps }, (_, i) => `outcome ${i + 1}`) });
  return made.id;
}
const UI = { tool: "Bash", command_includes: "ui-check.mjs", output_includes: "PASS" };
const upgrade = (name: string, text = "Run ui-check on every page I touch before I close a step.", scope = "before_report", check: unknown = UI) => j(call(name, "POST", "/self-upgrade", { text, scope, check }));
let callN = 0;
/** The real ui-check run lands in the agent's fixture transcript, then the hook's claim names its id. */
const UI_RUN = { tool: "Bash", input: { command: "node ui-check.mjs http://x" }, output: "ui-check: PASS 390x844" };
const proof = (name: string, c: Omit<FixtureCall, "id"> = UI_RUN) => { const id = `toolu_fixture${String(++callN).padStart(4, "0")}`; tr.writeCall(fileOf(name), { id, ...c }); return j(call(name, "POST", "/upgrade-proof", { tool_use_id: id, evidence: "claimed by the hook" })); };
const steps = async (name: string, n = 2, ev = ["check: bun test 9 pass 0 fail"]) => { for (let i = 0; i < n; i++) expect((await call(name, "POST", "/steps/done", { evidence: ev })).status).toBe(200); };
const report = (name: string) => j(call(name, "POST", "/report", { summary: `Done: ${name}.`, state: "done" }));
const lessons = (name: string) => { const l = ln.readLine(name)!; return readFileSync(join(ln.selfDir(name, l.current), "lessons.md"), "utf8"); };
const rules = (name: string) => { const l = ln.readLine(name)!; return readFileSync(join(ln.selfDir(name, l.current), "rules.md"), "utf8"); };

test("lines: first spawn creates line v1 from the soul and a picks row with prob", () => {
  const souls = soulsDir(); mkdirSync(souls, { recursive: true }); // config's ROOT, which an earlier test file in the same run may have fixed
  writeFileSync(join(souls, "agentnet-alpha-1.md"), "# Persona: fixture\n\nYou test things.\n");
  rt.createAgent({ name: "alpha-1", boss: "root", job: "t", goal: "g", by: "test", model: "sonnet", audit: "mode=normal model=sonnet" });
  const l = ln.readLine("alpha-1")!;
  expect(l).toMatchObject({ current: 1, baseline: null, status: "active", parent: null, role: "alpha" });
  expect(readFileSync(join(ln.selfDir("alpha-1", 1), "soul.md"), "utf8")).toContain("You test things.");
  expect(readFileSync(join(ln.selfDir("alpha-1", 1), "rules.md"), "utf8")).toBe("");
  expect(existsSync(join(ln.selfDir("alpha-1", 1), "skills"))).toBe(true);
  const picks = sc.scoreDb().query("SELECT kind, role, chosen, prob, context_json FROM picks WHERE role = 'alpha' ORDER BY id").all() as any[];
  expect(picks.map((p) => [p.kind, p.chosen, p.prob])).toEqual([["line", "alpha-1", 1], ["model", "sonnet", 1], ["soul", null, 1]]);
  expect(JSON.parse(picks[0].context_json).audit).toContain("mode=normal");
});

test("lines: import dry run writes nothing, apply creates a line per name", () => {
  rt.createAgent({ name: "beta-1", boss: "root", job: "t", goal: "g", by: "test" });
  rmSync(ln.lineDir("beta-1"), { recursive: true, force: true }); // as if spawned before 8a landed
  const dry = ln.importLines(false);
  expect(dry.find((r) => r.name === "beta-1")).toMatchObject({ exists: false });
  expect(existsSync(ln.lineDir("beta-1"))).toBe(false);
  ln.importLines(true);
  expect(ln.readLine("beta-1")?.current).toBe(1);
  expect(ln.readLine("root")?.current).toBe(1); // root gets a line too, never the gate
});

test("upgrade: rejects short text, short matcher, boot-satisfied matcher and reverted duplicate", async () => {
  on();
  await spawn("gamma-1");
  expect((await upgrade("gamma-1", "too short")).status).toBe(422);
  expect((await upgrade("gamma-1", undefined, "before_report", { tool: "Bash", command_includes: "ab" })).body.detail).toContain("at least 4 characters");
  expect((await upgrade("gamma-1", undefined, "before_report", { tool: "Bash", command_includes: "...." })).status).toBe(422);
  const who = { id: "gamma-1#1", name: "gamma-1", gen: 1 };
  const done = [{ tool: "Bash", input: { command: "node ~/x/ui-check.mjs http://a" }, output: "PASS 390x844" }];
  const r = ln.proposeUpgrade(who, { text: "Run ui-check on every page I touch before I close a step.", scope: "every_step", check: UI }, done);
  expect("error" in r && r.error).toContain("already satisfied");
  // a reverted upgrade of the line: near-same text, or the identical check, is refused
  sc.scoreDb().run("INSERT INTO line_versions (line, version, parent_version, upgrade_json, born_gen, status, created) VALUES ('gamma-1', 9, 1, ?, 0, 'reverted', 0)",
    [JSON.stringify({ text: "Run ui-check on each page I touch before I close any step.", scope: "every_step", check: { file_glob: "docs/**/*.md" } })]);
  expect((await upgrade("gamma-1")).body.detail).toContain("already reverted");
  expect((await upgrade("gamma-1", "Write a short design note before I start building the page.", "before_report", { file_glob: "docs/**/*.md" })).body.detail).toContain("already reverted");
  expect((await upgrade("gamma-1", "Write a short design note before I start building the page.", "before_report", { file_glob: "notes/*.md" })).status).toBe(201);
});

test("upgrade: step_done refused until an upgrade is accepted, then allowed (lines on); unchanged with lines off", async () => {
  on();
  await spawn("delta-1");
  const r = await j(call("delta-1", "POST", "/steps/done", { evidence: ["check: bun test 1 pass 0 fail"] }));
  expect(r.status).toBe(409); expect(r.body.detail).toContain("propose your upgrade first: self_upgrade");
  expect((await upgrade("delta-1")).status).toBe(201);
  expect((await call("delta-1", "POST", "/steps/done", { evidence: ["check: bun test 1 pass 0 fail"] })).status).toBe(200);
  // every_step: each step needs a proof since the last one
  await spawn("delta-2", 2);
  expect((await upgrade("delta-2", undefined, "every_step")).status).toBe(201);
  const no = await j(call("delta-2", "POST", "/steps/done", { evidence: ["check: bun test 1 pass 0 fail"] }));
  expect(no.status).toBe(409); expect(no.body.detail).toContain("Your upgrade: Run ui-check");
  expect((await proof("delta-2")).status).toBe(201);
  expect((await call("delta-2", "POST", "/steps/done", { evidence: ["check: bun test 1 pass 0 fail"] })).status).toBe(200);
  expect((await call("delta-2", "POST", "/steps/done", { evidence: ["check: bun test 1 pass 0 fail"] })).status).toBe(409); // no new proof since step 1
  off();
  await spawn("delta-3");
  expect((await call("delta-3", "POST", "/steps/done", { evidence: ["check: bun test 1 pass 0 fail"] })).status).toBe(200);
  expect((await upgrade("delta-3")).status).toBe(409); // lines off: no upgrades
  expect((await j(call("delta-3", "POST", "/hello", { session: "s2", pid: 50_100 }))).body.lines).toBe(false);
});

test("upgrade: second self_upgrade in one generation is 409", async () => {
  on();
  await spawn("eps-1");
  expect((await upgrade("eps-1")).status).toBe(201);
  const r = await upgrade("eps-1", "A different rule that I would like to follow this time.", "before_report", { file_glob: "src/**/*.ts" });
  expect(r.status).toBe(409); expect(r.body.detail).toContain("one per generation");
  expect((await j(call("eps-1", "GET", "/agent/upgrade"))).body.upgrade.text).toContain("Run ui-check");
});

test("settle: followed and better is kept, rules.md has the text, current moves", async () => {
  on();
  await spawn("zeta-1");
  expect((await upgrade("zeta-1")).status).toBe(201);
  await steps("zeta-1"); expect((await proof("zeta-1")).status).toBe(201);
  const r = await report("zeta-1"); expect(r.status).toBe(200); expect(r.body.finished).toBeTruthy();
  const v = ln.upgradeOf("zeta-1", 1)!;
  expect(v.status).toBe("kept"); expect(v.reward).toBe(5); // 0.75 x hard 5 + 0.25 x auto 5
  expect(ln.readLine("zeta-1")).toMatchObject({ current: 2, baseline: 5 });
  expect(rules("zeta-1")).toContain("Run ui-check on every page I touch");
  expect(readFileSync(join(ln.selfDir("zeta-1", 2), "soul.md"), "utf8")).toBe(readFileSync(join(ln.selfDir("zeta-1", 1), "soul.md"), "utf8"));
});

test("settle: followed and worse is reverted with a Don't lesson; not followed is reverted with a not-followed lesson", async () => {
  on();
  // gen 2 of zeta-1 (baseline 5): followed, but no step has verified proof
  await spawn("zeta-1");
  expect((await upgrade("zeta-1", "Write the decision note into docs before every commit I make.", "before_report", { file_glob: "docs/notes/*.md" })).status).toBe(201);
  await steps("zeta-1", 2, ["none: nothing to show"]); expect((await proof("zeta-1", { tool: "Write", input: { file_path: "/fixture/lines-work/docs/notes/d.md", content: "x" }, output: "ok" })).status).toBe(201);
  expect((await report("zeta-1")).status).toBe(200);
  const v = ln.upgradeOf("zeta-1", 2)!;
  expect(v.status).toBe("reverted"); expect(v.reward!).toBeLessThan(5); expect(v.baseline).toBe(5);
  expect(ln.readLine("zeta-1")!.current).toBe(2);
  expect(lessons("zeta-1")).toContain("Don't: Write the decision note into docs before every commit I make. (reward");
  // a judgment check: two agent proofs are adherence (each counts half), one is not
  await spawn("eta-1");
  expect((await upgrade("eta-1", "Ask myself whether the change is the smallest that works.", "every_step", { judgment: true })).status).toBe(201);
  expect((await j(call("eta-1", "POST", "/upgrade-proof", { evidence: "x" }))).status).toBe(409); // a hook proof for a judgment check is refused
  for (let i = 0; i < 2; i++) { await Bun.sleep(2); expect((await j(call("eta-1", "POST", "/upgrade-proof/agent", { evidence: "kept the diff to one file" }))).status).toBe(201); await steps("eta-1", 1); }
  // two agent proofs = adherence; force the not-followed case on a fresh gen with one proof only
  expect((await report("eta-1")).status).toBe(200);
  expect(ln.upgradeOf("eta-1", 1)!.status).toBe("kept");
  await spawn("eta-1", 1);
  expect((await upgrade("eta-1", "State the risk of each change in one line in the step note.", "before_report", { judgment: true })).status).toBe(201);
  expect((await j(call("eta-1", "POST", "/upgrade-proof/agent", { evidence: "said the risk" }))).status).toBe(201);
  await steps("eta-1", 1);
  expect((await report("eta-1")).status).toBe(200);
  expect(ln.upgradeOf("eta-1", 2)!.status).toBe("reverted");
  expect(lessons("eta-1")).toContain("Upgrade not followed: State the risk of each change");
});

test("settle: provisional auto grade counts half; root regrade flips the decision and is idempotent", async () => {
  expect(ln.rewardOf({ grade: 1, provisional: 1, verified: 2, done: 2, rework: 0 })).toBe(4); // 0.75 x 5 + 0.25 x 1
  expect(ln.rewardOf({ grade: 1, provisional: 0, verified: 2, done: 2, rework: 0 })).toBe(3); // 0.5 x 5 + 0.5 x 1
  expect(ln.rewardOf({ grade: 5, provisional: 0, verified: 2, done: 2, rework: 1 })).toBe(4.5);
  on();
  // gen 3 of zeta-1: followed and as good as the baseline, kept (v3)
  await spawn("zeta-1");
  expect((await upgrade("zeta-1", "Commit with a message that names the step it closes, always.", "before_report", { commit_msg_includes: "step 3." })).status).toBe(201);
  await steps("zeta-1"); expect((await proof("zeta-1", { tool: "Bash", input: { command: "git commit -m 'feat: closes step 3. the thing'" }, output: "[main 1a2b3c4] feat: closes step 3. the thing" })).status).toBe(201);
  expect((await report("zeta-1")).status).toBe(200);
  expect(ln.upgradeOf("zeta-1", 3)!.status).toBe("kept"); expect(ln.readLine("zeta-1")!.current).toBe(3);
  // root grades it 1: reward 3 < baseline, so it flips to reverted, v3 goes, current back to 2, a lesson appears
  expect("error" in sc.grade("zeta-1", { gen: 3, job: 1, grade: 1 })).toBe(false);
  const v = ln.upgradeOf("zeta-1", 3)!;
  expect(v.status).toBe("reverted"); expect(v.reward).toBe(3);
  expect(ln.readLine("zeta-1")!.current).toBe(2); expect(existsSync(ln.selfDir("zeta-1", 3))).toBe(false);
  expect(lessons("zeta-1")).toContain("Don't: Commit with a message that names the step");
  const once = lessons("zeta-1");
  expect(ln.settleLine("zeta-1", 3, 1)!.changed).toBe(false); // idempotent
  expect(lessons("zeta-1")).toBe(once);
  // root grades it 5 after all: back to kept, the lesson line is gone, v3 is current again
  sc.grade("zeta-1", { gen: 3, job: 1, grade: 5 });
  expect(ln.upgradeOf("zeta-1", 3)!.status).toBe("kept");
  expect(ln.readLine("zeta-1")!.current).toBe(3);
  expect(lessons("zeta-1")).not.toContain("Commit with a message");
  expect(rules("zeta-1")).toContain("Commit with a message that names the step");
});

test("settle: a throwing settle never blocks despawn", async () => {
  on();
  await spawn("theta-1", 1);
  expect((await upgrade("theta-1", "State the risk of each change in one line in the step note.", "before_report", { judgment: true })).status).toBe(201);
  expect((await j(call("theta-1", "POST", "/upgrade-proof/agent", { evidence: "said the risk" }))).status).toBe(201);
  await steps("theta-1", 1);
  const p = join(ln.selfDir("theta-1", 1), "lessons.md"); rmSync(p); mkdirSync(p); // one agent proof: not followed -> revert -> the lesson write throws
  const r = await report("theta-1");
  expect(r.status).toBe(200); expect(r.body.finished).toBeTruthy();
  expect(rt.byName("theta-1")).toBeNull(); // despawned anyway
});

test("lines: agent settings deny writes to lines/", () => {
  const d = denyRules();
  expect(d.some((x) => x.startsWith("Edit(") && x.endsWith("/lines/**)"))).toBe(true);
  expect(d.some((x) => x.startsWith("Read(") && x.includes("/lines/"))).toBe(false);
});

test("upgrade: boot prompt lists the last 3 kept/reverted upgrades with reward", async () => {
  on();
  await spawn("zeta-1"); // gen 4: the boot block is fetched after its spawn
  const r = await j(call("root", "GET", "/agents/zeta-1/handover"));
  expect(r.status).toBe(200);
  const b: string = r.body.lines;
  expect(b).toContain("Aim: the highest grade for this job.");
  expect(b).toContain("Parent generation's grade: 5/5 (gen 3 job 1)");
  expect(b).toContain("Run ui-check on every page I touch");               // rules
  expect(b).toContain("propose one upgrade with mcp__agentnet__self_upgrade");
  const last = b.slice(b.indexOf("Last upgrades:")).split("\n").filter((l) => l.startsWith("- "));
  expect(last.length).toBe(3);
  expect(last[0]).toContain('kept: "Commit with a message'); expect(last[0]).toMatch(/reward 5, baseline \d/);
  expect(last[1]).toMatch(/reverted: "Write the decision note.*reward [\d.]+, baseline 5/);
  off();
  expect((await j(call("root", "GET", "/agents/zeta-1/handover"))).body?.lines).toBeUndefined();
});
