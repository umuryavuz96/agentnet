// Owner asks (e)-(g): learning on owner events only, liked examples in the boot prompt, the weekly rule prune with token counts, and usage.
// Scratch home, in-memory DBs, a stub model (no claude call).
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-learn-"));
process.env.AGENTNET_OWNER_ASKS = "1";
const { Database } = await import("bun:sqlite");
const { db, useDatabase } = await import("../src/core/db");
const st = await import("../src/net/store");
const rt = await import("../src/net/routes");
const sc = await import("../src/net/scores");
const ln = await import("../src/net/lines");
const oa = await import("../src/net/ownerAsks");
const ol = await import("../src/net/ownerLearn");

const T0 = Date.parse("2026-11-18T10:00:00Z");
const lessons = (line: string) => readFileSync(join(ln.selfDir(line, ln.readLine(line)!.current), "lessons.md"), "utf8").split("\n").filter(Boolean);
const rules = (line: string) => readFileSync(join(ln.selfDir(line, ln.readLine(line)!.current), "rules.md"), "utf8");
let n = 0;
function worker(role = "web-dev", project: string | null = null) {
  const name = `${role}-${++n}`, made = rt.createAgent({ name, boss: "root", job: "t", goal: "g", by: "test", ...(project ? { project } : {}) }, T0);
  ln.ensureLine(name, "soul", T0);
  rt.startJob(made.id, { by: "root", goal: "Build the borsa chart page", steps: ["Chart renders the 7 day series", "Phone layout fits 390"] }, T0);
  return { name, id: made.id };
}
function goal(text: string, w?: { name: string; id: string }) {
  const id = Number(db().run("INSERT INTO owner_goals (source, msg_id, text, status, created_at, updated_at) VALUES ('tg', ?, ?, 'doing', ?, ?)", [`m${++n}`, text, T0, T0]).lastInsertRowid);
  if (w) db().run("INSERT INTO owner_links (goal_id, agent_id, agent, job_id, how, at) VALUES (?, ?, ?, 1, 'root', ?)", [id, w.id, w.name, T0]);
  return db().query("SELECT * FROM owner_goals WHERE id = ?").get(id) as import("../src/net/ownerAsks").GoalRow;
}

beforeAll(() => {
  useDatabase(new Database(":memory:")); st._reset(); sc.useScoreDb(new Database(":memory:"));
  rt.createAgent({ name: "root", job: "t", by: "test", standing: true });
  ln.ensureLine("root", "root soul", T0);
  oa.ensureSchema();
});
beforeEach(() => { for (const t of ["owner_msgs", "owner_goals", "owner_links", "owner_items"]) db().run(`DELETE FROM ${t}`); });

test("owner-learn: rework and complaint write one lesson per job and type on the linked agent's line", () => {
  const w = worker(), g = goal("Borsa chart is hard to read, rethink it", w);
  ol.onOwnerEvent({ type: "rework", goal: g, text: "still hard to read on the phone", about: null }, T0);
  ol.onOwnerEvent({ type: "rework", goal: g, text: "again hard to read", about: null }, T0);
  ol.onOwnerEvent({ type: "complaint", goal: g, text: "the labels overlap the bars", about: "borsa chart" }, T0);
  const l = lessons(w.name);
  expect(l.filter((x) => x.startsWith("Rework: Borsa chart is hard to read"))).toHaveLength(1);
  expect(l).toContain("Owner complaint: the labels overlap the bars");
  expect(l).toHaveLength(2);
  expect(ol.onOwnerEvent({ type: "rework", goal: null, text: "x", about: null }, T0)).toEqual({ lessons: [], liked: [] });
});

test("owner-learn: a mark on root's breakdown is a lesson on root's line; missing names his text", () => {
  const w = worker(), g = goal("Make the asks page", w);
  const item = { id: 41, goal_id: g.id, origin: "brief", text: "Add a pie chart", status: "open" } as unknown as import("../src/net/ownerAsks").ItemRow;
  ol.onOwnerEvent({ type: "mark", goal: g, text: "Add a pie chart", about: null, item, mark: "unwanted" }, T0);
  ol.onOwnerEvent({ type: "mark", goal: g, text: "Add a pie chart", about: null, item, mark: "unwanted" }, T0);
  ol.onOwnerEvent({ type: "mark", goal: g, text: "a push when it stalls", about: null, item: null, mark: "missing" }, T0);
  const l = lessons("root");
  expect(l).toContain(`Breakdown: Add a pie chart was not wanted (G${g.id})`);
  expect(l).toContain(`Breakdown missed: a push when it stalls (G${g.id})`);
  expect(l.filter((x) => x.includes("pie chart"))).toHaveLength(1);
  expect(lessons(w.name)).toHaveLength(0);
});

test("owner-learn: praise saves a liked example ≤ 1.5 kB; the boot block of the same role or project gets the newest 2, ≤ 1.2 kB", () => {
  const w = worker("designer", "/p/borsa"), g = goal("Borsa chart redesign with real prices ".repeat(20), w);
  const out = ol.onOwnerEvent({ type: "praise", goal: g, text: "çok beğendim", about: null }, T0);
  expect(out.liked).toHaveLength(1);
  const f = out.liked[0]!; expect(existsSync(f)).toBe(true); expect(f).toContain(`/liked/designer/${w.name}-g`);
  const md = readFileSync(f, "utf8");
  expect(md.length).toBeLessThanOrEqual(1500); expect(md).toContain("Owner said: çok beğendim"); expect(md).toContain("project: /p/borsa");
  for (let i = 0; i < 2; i++) ol.onOwnerEvent({ type: "praise", goal: goal(`more ${i}`, worker("designer")), text: "nice", about: null }, T0);
  const s = ol.likedSection("designer-9", null);
  expect(s).toStartWith("## Work the owner liked\nThe owner liked this. Follow its direction.");
  expect(s.length - s.indexOf("\n\n") - 2).toBeLessThanOrEqual(1200);
  expect(s.split("# Liked:").length - 1).toBe(2);
  expect(ol.likedSection("backend-1", "/p/borsa")).toContain(w.name); // project match, other role
  expect(ol.likedSection("backend-1", "/p/other")).toBe("");
});

test("owner-learn: the prune removes a kept rule not followed or not helping; dry run changes nothing; tokens counted before and after", async () => {
  const name = "pr-1"; rt.createAgent({ name, boss: "root", job: "t", by: "test" }, T0); ln.ensureLine(name, "soul", T0);
  const lj = ln.readLine(name)!;
  writeFileSync(join(ln.selfDir(name, lj.current), "rules.md"), "Run the ui check before each step\nWrite a decision note\nKeep it\n");
  const add = (gen: number, text: string, status: string, reward: number | null, baseline: number | null, check: object) =>
    sc.scoreDb().run("INSERT INTO line_versions (line, version, parent_version, upgrade_json, born_gen, status, reward, adherence, baseline, lesson, created, settled_at) VALUES (?, ?, 1, ?, ?, ?, ?, 1, ?, NULL, ?, ?)",
      [name, gen, JSON.stringify({ text, scope: "every_step", check }), gen, status, reward, baseline, T0, T0]);
  add(1, "Run the ui check before each step", "kept", 4, 3, { tool: "Bash", command_includes: "ui-check.mjs" }); // not followed (no transcripts)
  add(2, "Write a decision note", "kept", 4, 4.2, { judgment: true }); // not helping: later mean 3.5 <= 4.2 - 0.5
  add(3, "Keep it", "kept", 4, 3, { judgment: true }); // helping: later mean 3.5 > 3 - 0.5
  for (const gen of [4, 5, 6]) add(gen, `try ${gen}`, "reverted", 3.5, 3, { judgment: true });
  // stub model: input tokens = chars / 4, an empty input costs 10
  ol.pruneDeps.model = async (_s, input) => ({ text: "ok", tokens: 10 + (input === "." ? 0 : Math.ceil(input.length / 4)) });
  const dry = await ol.pruneRules(false, T0);
  expect(dry.pruned.map((p) => p.text).sort()).toEqual(["Run the ui check before each step", "Write a decision note"]);
  expect(dry.pruned.find((p) => p.text.startsWith("Run"))!.reason).toBe("not followed in the last 3 jobs");
  expect(dry.pruned.find((p) => p.text.startsWith("Write"))!.reason).toContain("not helping");
  expect(rules(name)).toContain("Run the ui check");
  expect(dry.before).toBeGreaterThan(dry.after!);
  const real = await ol.pruneRules(true, T0);
  expect(real.pruned).toHaveLength(2);
  expect(rules(name).trim()).toBe("Keep it");
  expect(lessons(name)).toContain("Pruned: Write a decision note (not helping: mean reward 3.50 after keeping, baseline 4.2)");
  expect(ln.versionsOf(name).filter((r) => r.status === "pruned")).toHaveLength(2);
  expect((await ol.pruneRules(false, T0)).pruned).toHaveLength(0);
  expect(readFileSync(join((await import("../src/core/config")).ROOT, "logs", "rule-prune.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
});

test("owner-learn: the weekly tick runs once on Monday after 04:00 and tells root", async () => {
  ol.pruneDeps.model = async () => ({ text: "ok", tokens: 10 });
  const told: string[] = [], mon = new Date(2026, 10, 16, 4, 30).getTime(), tue = new Date(2026, 10, 17, 4, 30).getTime();
  expect(await ol.pruneTick(new Date(2026, 10, 16, 3, 0).getTime(), (t) => told.push(t))).toBeNull();
  expect(await ol.pruneTick(tue, (t) => told.push(t))).toBeNull();
  expect(await ol.pruneTick(mon, (t) => told.push(t))).not.toBeNull();
  expect(await ol.pruneTick(mon + 3_600_000, (t) => told.push(t))).toBeNull();
  expect(told).toHaveLength(1); expect(told[0]).toStartWith("Weekly rule prune:");
});

test("owner-learn: usage sums classify and coverage tokens per day", () => {
  const ins = (id: string, kind: string, tokens: number, at: number) => db().run("INSERT INTO owner_msgs (source, msg_id, ts, text, kind, tokens, at) VALUES ('tg', ?, ?, '', ?, ?, ?)", [id, at, kind, tokens, at]);
  ins("a", "goal", 1200, T0); ins("b", "chat", 800, T0); ins("c", "coverage", 1500, T0); ins("d", "skip", 0, T0); ins("e", "goal", 999, T0 - 86_400_000);
  const u = oa.usageByDay(2, T0);
  expect(u.cap).toBe(250_000);
  expect(u.days[0]).toMatchObject({ classify: 2000, classify_calls: 2, coverage: 1500, coverage_calls: 1, total: 3500 });
  expect(u.days[1]).toMatchObject({ classify: 999, total: 999 });
});
