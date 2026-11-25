// Owner goals ledger (docs/internal/SPEC-asks-ledger.md, step 2: capture, link, gates, stall). Scratch home, in-memory DBs, fixture
// transcripts, a stub model (no claude call), an injected clock.
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-owner-"));
process.env.AGENTNET_OWNER_ASKS = "1";
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { db, useDatabase } = await import("../src/core/db");
const { dir } = await import("../src/core/config");
const { tracing } = await import("../src/core/http");
type Env = import("../src/core/http").Env;
const st = await import("../src/net/store");
const rt = await import("../src/net/routes");
const sc = await import("../src/net/scores");
const oa = await import("../src/net/ownerAsks");

const app = new Hono<Env>(); app.use("*", tracing); const api = new Hono<Env>(); rt.agentnetRoutes(api); app.route("/api/v1", api);
const tok: Record<string, string> = {};
const call = (who: string, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/agentnet${path}`, { method, headers: { authorization: `Bearer ${tok[who] ?? who}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const j = async (p: Response | Promise<Response>) => { const r = await p; return { status: r.status, body: await r.json().catch(() => null) as any }; };

// ---------- the stub model ----------
let calls: string[] = [], reply: (system: string, input: string) => string = () => '{"kind":"goal","list":[],"about":null}';
oa.ownerDeps.model = async (system, input) => { calls.push(input); return { text: reply(system, input), tokens: 767 }; };
const notified: { kind: string; md: string }[] = [];
oa.ownerDeps.notify = (kind, _g, md) => { notified.push({ kind, md }); };
const T0 = Date.parse("2026-11-18T10:00:00Z");
const msg = (id: string, text: string, ts = T0) => ({ source: "tg", msgId: id, ts, text });
const cfg = { daily_token_cap: 250_000 };
const toRoot = () => { const r = rt.byName("root")!; return db().query("SELECT * FROM messages WHERE to_agent IN (?, '@admin') AND from_agent = '@agentnet' ORDER BY id").all(r.id) as { body: string; subject: string }[]; };
const toAgentMsgs = (id: string) => db().query("SELECT * FROM messages WHERE to_agent = ? AND from_agent = '@agentnet' ORDER BY id").all(id) as { body: string }[];

let n = 0;
async function agent(steps: string[], brief?: string, goalId?: number) {
  const name = `ow-${++n}`, made = rt.createAgent({ name, boss: "root", job: "t", goal: "g", by: "test" }, T0 - 60_000);
  tok[name] = made.token;
  await call(name, "POST", "/hello", { session: `s-${name}`, pid: 50_000 + n });
  let briefPath: string | null = null;
  if (brief != null) { briefPath = join(process.env.AGENTNET_HOME!, `brief-${name}.md`); writeFileSync(briefPath, brief); }
  const r = rt.startJob(made.id, { by: "root", goal: "fixture job", brief: briefPath, steps, goalId }, T0);
  return { name, id: made.id, warnings: r.warnings };
}
const goals = () => db().query("SELECT * FROM owner_goals ORDER BY id").all() as import("../src/net/ownerAsks").GoalRow[];

beforeAll(() => {
  useDatabase(new Database(":memory:")); st._reset(); sc.useScoreDb(new Database(":memory:"));
  tok.root = rt.createAgent({ name: "root", job: "t", by: "test", standing: true }).token;
});
beforeEach(() => {
  oa.ensureSchema();
  for (const t of ["owner_msgs", "owner_goals", "owner_links", "owner_items"]) db().run(`DELETE FROM ${t}`);
  db().run("DELETE FROM messages"); calls = []; notified.length = 0;
  reply = () => '{"kind":"goal","list":[],"about":null}';
});

test("owner-asks: scan reads only owner messages, dedupes by msg id, keeps offsets", () => {
  const home = process.env.AGENTNET_HOME!, main = join(home, "tx", "main"), voice = join(home, "tx", "voice");
  mkdirSync(main, { recursive: true }); mkdirSync(voice, { recursive: true });
  const ch = (id: string, uid: string, text: string) => JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-11-18T10:00:01Z",
    content: `<channel source="plugin:telegram:telegram" chat_id="1" message_id="${id}" user="o" user_id="${uid}" ts="2026-11-18T10:00:00.000Z">\n${text}\n</channel>` });
  const f = join(main, "a.jsonl");
  writeFileSync(f, [ch("100", "42", "make the office desks look real"), ch("101", "99", "someone else"), JSON.stringify({ type: "user", message: { content: [{ type: "text", text: `<channel source="plugin:telegram:telegram" chat_id="1" message_id="100" user="o" user_id="42" ts="2026-11-18T10:00:00.000Z">\nmake the office desks look real\n</channel>` }] } }), ch("100", "42", "make the office desks look real")].join("\n") + "\n");
  writeFileSync(join(voice, "v.jsonl"), [JSON.stringify({ type: "user", uuid: "u-1", timestamp: "2026-11-18T10:05:00Z", message: { content: "[Voice tr] ofis masalarını düzelt lütfen" } }),
    JSON.stringify({ type: "user", uuid: "u-2", timestamp: "2026-11-18T10:06:00Z", message: { content: "not a voice turn" } })].join("\n") + "\n");
  const c: import("../src/net/ownerAsks").OwnerCfg = { owner_user_id: "42", daily_token_cap: 1, sources: [{ name: "tg", glob: join(main, "*.jsonl"), format: "telegram-channel" }, { name: "voice", glob: join(voice, "*.jsonl"), format: "voice-prefix" }] };
  const NOW = Date.parse("2026-11-18T12:00:00Z"), first = oa.scanFiles(c, NOW);
  expect(first.map((m) => `${m.source}:${m.msgId}`).sort()).toEqual(["tg:100", "tg:100", "tg:100", "voice:u-1"]); // queue row, user turn, repeat: ingest keeps one by (source, msg_id)
  expect(first.find((m) => m.source === "voice")!.text).toBe("ofis masalarını düzelt lütfen");
  expect(oa.scanFiles(c, NOW)).toEqual([]); // offsets kept: nothing new
  appendFileSync(f, ch("102", "42", "and the lamp") + "\n" + '{"type":"queue-ope'); // a half-written line waits
  expect(oa.scanFiles(c, NOW).map((m) => m.msgId)).toEqual(["102"]);
  // the ledger starts on the day of its first scan: an older message in a long-lived file is never read
  appendFileSync(f, '"}\n' + ch("103", "42", "old ask from yesterday").replace("2026-11-18T10:00:00.000Z", "2026-11-17T20:00:00.000Z") + "\n");
  expect(oa.scanFiles(c, NOW)).toEqual([]);
});

test("owner-asks: pre-filter skips acks with no model call; classify makes one goal and his explicit list items, with tokens", async () => {
  expect(await oa.ingest(msg("1", "ok"), cfg, T0)).toBeNull();
  expect(await oa.ingest(msg("2", "tamam 👍"), cfg, T0)).toBeNull();
  expect(calls.length).toBe(0);
  reply = () => '{"kind":"goal","list":["fix the lamp","send shots at 390"],"about":null}';
  const id = (await oa.ingest(msg("3", "Bot, two things: 1. fix the lamp 2. send shots at 390"), cfg, T0))!;
  expect(calls.length).toBe(1);
  expect(await oa.ingest(msg("3", "same id again"), cfg, T0)).toBeNull(); // dedupe by msg id: no second call
  expect(calls.length).toBe(1);
  const g = oa.goalById(id)!;
  expect(g.text).toContain("two things"); expect(g.status).toBe("open"); expect(g.msg_id).toBe("3");
  expect(oa.itemsOf(id).map((x) => [x.origin, x.text])).toEqual([["owner", "fix the lamp"], ["owner", "send shots at 390"]]);
  expect(oa.tokensToday(T0)).toBe(767);
  reply = () => '{"kind":"chat","list":[],"about":null}';
  expect(await oa.ingest(msg("4", "what is the disk usage right now?"), cfg, T0)).toBeNull();
  expect(goals().length).toBe(1);
});

test("owner-asks: repeat of an open goal is a dup; repeat of a done goal reopens it (rework)", async () => {
  const events: string[] = []; oa.learnFns.push((e) => events.push(e.type));
  const id = (await oa.ingest(msg("10", "redesign the agent map in 2d with the new cards"), cfg, T0))!;
  expect(await oa.ingest(msg("11", "redesign the agent map in 2d with the new cards please"), cfg, T0 + 1000)).toBe(id);
  expect(goals().length).toBe(1);
  expect(oa.goalById(id)!.note).toContain("again");
  db().run("UPDATE owner_goals SET status = 'done', done_at = ? WHERE id = ?", [T0 + 2000, id]);
  expect(await oa.ingest(msg("12", "redesign the agent map in 2d with the new cards"), cfg, T0 + 3000)).toBe(id);
  expect(oa.goalById(id)!.status).toBe("open");
  expect(events).toEqual(["rework"]);
  oa.learnFns.length = 0;
});

test("owner-asks: job links by Goal: line, then by msg id, then auto overlap; brief steps become items; step_add and step_drop follow", async () => {
  const g1 = (await oa.ingest(msg("6260", "build the trail page exactly like the board"), cfg, T0))!;
  const g2 = (await oa.ingest(msg("6261", "the boiler card shows the wrong temperature on the dashboard"), cfg, T0))!;
  const a = await agent(["port the board", "match motion"], `# Brief\nGoal: G${g2}\nOwner msg 6260 said something.\n`);
  expect(oa.linksOf(g2).map((l) => l.how)).toEqual(["cited"]); // cited beats the msg id
  expect(a.warnings.join(" ")).toContain(`G${g2}`);
  const b = await agent(["port it"], "# Brief\nFrom Telegram msg 6260: the trail page.\n");
  expect(oa.linksOf(g1).map((l) => [l.agent, l.how])).toEqual([[b.name, "msg-id"]]);
  const g3 = (await oa.ingest(msg("6262", "make the asks page show proof links for every finished goal"), cfg, T0))!;
  const c = await agent(["page", "push"], "# Brief\nWe build an asks page that shows proof links for every finished goal, with push.\n");
  expect(oa.linksOf(g3).map((l) => l.how)).toEqual(["auto"]);
  expect(oa.itemsOf(g3).map((x) => [x.origin, x.step_n, x.status])).toEqual([["brief", 1, "doing"], ["brief", 2, "doing"]]);
  expect(oa.goalById(g3)!.status).toBe("doing");
  expect((await call(c.name, "POST", "/steps", { text: "digest", because: "self" })).status).toBe(200);
  expect((await call(c.name, "POST", "/steps/2/drop", { reason: "push moves to the next job" })).status).toBe(200);
  oa.syncGoal(g3);
  expect(oa.itemsOf(g3).map((x) => [x.step_n, x.status])).toEqual([[1, "doing"], [2, "dropped"], [3, "doing"]]);
  const none = await agent(["x"], "# Brief\nSomething unrelated about minecraft backups.\n");
  expect(none.warnings.join(" ")).toContain("no owner goal matched");
});

test("owner-asks: coverage flags uncovered words to root once", async () => {
  const g = (await oa.ingest(msg("20", "fix the 3d desks and also the door and the lamp"), cfg, T0))!;
  await agent(["desks", "door"], `Goal: G${g}\n`);
  reply = (system) => system.includes("to-do items") ? '{"uncovered":["the lamp"]}' : '{"kind":"goal","list":[],"about":null}';
  await oa.coverageTick(T0 + 60_000);
  await oa.coverageTick(T0 + 120_000);
  const r = toRoot().filter((m) => m.subject.includes("not covered"));
  expect(r.length).toBe(1); expect(r[0]!.body).toContain('"the lamp"');
  expect(JSON.parse(oa.goalById(g)!.coverage!)).toEqual(["the lamp"]);
});

test("owner-asks: step_done with only none: on an item step is refused; verified evidence closes the item", async () => {
  const g = (await oa.ingest(msg("30", "write the owner asks spec and commit it"), cfg, T0))!;
  const a = await agent(["spec"], `Goal: G${g}\n`);
  const no = await j(call(a.name, "POST", "/steps/done", { evidence: ["none: it is a doc"] }));
  expect(no.status).toBe(422); expect(no.body.detail).toContain(`G${g}`);
  const bad = await j(call(a.name, "POST", "/steps/done", { evidence: ["file: /no/such/file.md"] }));
  expect(bad.status).toBe(422);
  const f = join(process.env.AGENTNET_HOME!, "spec.md"); writeFileSync(f, "x");
  expect((await call(a.name, "POST", "/steps/done", { evidence: [`file: ${f}`] })).status).toBe(200);
  expect(oa.itemsOf(g)[0]).toMatchObject({ status: "done", proof: `file: ${f}` });
  expect(oa.goalById(g)!.status).toBe("done");
  expect(notified.map((x) => x.kind)).toEqual(["done"]);
});

test("owner-asks: done report refused while an item has no proof; last item closes the goal", async () => {
  process.env.AGENTNET_OWNER_ASKS = "0"; // the job runs before the goal exists: steps close with none:
  const a = await agent(["one", "two"]);
  for (let i = 0; i < 2; i++) expect((await call(a.name, "POST", "/steps/done", { evidence: ["none: before the goal"] })).status).toBe(200);
  process.env.AGENTNET_OWNER_ASKS = "1";
  const g = (await oa.ingest(msg("40", "two outcomes for the release"), cfg, T0))!;
  expect(oa.rootLink(g, a.name)).toMatchObject({ id: g });
  const r = await j(call(a.name, "POST", "/report", { summary: "done", state: "done" }));
  expect(r.status).toBe(409); expect(r.body.detail).toContain("no proof");
  const items = oa.itemsOf(g);
  const f = join(process.env.AGENTNET_HOME!, "proof.txt"); writeFileSync(f, "x");
  expect((await j(call("root", "POST", `/owner-items/${items[0]!.id}/done`, { proof: "none: nope" }))).status).toBe(422);
  expect((await j(call("root", "POST", `/owner-items/${items[0]!.id}/done`, { proof: `file: ${f}` }))).status).toBe(200);
  expect(oa.goalById(g)!.status).not.toBe("done");
  expect((await j(call("root", "POST", `/owner-items/${items[1]!.id}/done`, { proof: `file: ${f}` }))).status).toBe(200);
  expect(oa.goalById(g)!.status).toBe("done");
  expect((await j(call(a.name, "GET", "/owner-goals"))).status).toBe(403);
  expect((await j(call("root", "GET", "/owner-goals"))).body.goals.some((x: { id: number }) => x.id === g)).toBe(true);
});

test("owner-asks: unlinked open goal pings root once after 30 min; backfilled goals (before the first scan) never ping", async () => {
  writeFileSync(join(dir("data"), "owner-scan.json"), JSON.stringify({ _start: T0 - 3_600_000, _first: T0 - 60_000 }));
  await oa.ingest(msg("49", "old ask from the backfill about the lamp colours", T0 - 30 * 60_000), cfg, T0);
  await oa.ingest(msg("50", "set up the evening digest for the asks page"), cfg, T0);
  await oa.ownerTick(T0 + 29 * 60_000);
  expect(toRoot().filter((m) => m.subject.includes("without a job")).length).toBe(0);
  await oa.ownerTick(T0 + 31 * 60_000);
  await oa.ownerTick(T0 + 40 * 60_000);
  const r = toRoot().filter((m) => m.subject.includes("without a job"));
  expect(r.length).toBe(1); expect(r[0]!.body).toContain("evening digest"); expect(r[0]!.body).not.toContain("lamp");
});

test("owner-asks: stall ladder agent 45, root 90, owner 135; a closed item resets", async () => {
  const g = (await oa.ingest(msg("60", "port the 3d office monitors to every desk"), cfg, T0))!;
  const a = await agent(["monitors", "shots"], `Goal: G${g}\n`);
  const L = oa.linksOf(g)[0]!.at; // link time is the clock start
  await oa.ownerTick(L + 44 * 60_000); expect(toAgentMsgs(a.id).length).toBe(0);
  await oa.ownerTick(L + 46 * 60_000); expect(toAgentMsgs(a.id).length).toBe(1);
  await oa.ownerTick(L + 50 * 60_000); expect(toAgentMsgs(a.id).length).toBe(1);
  await oa.ownerTick(L + 91 * 60_000); expect(toRoot().filter((m) => m.subject.includes("stalling")).length).toBe(1);
  await oa.ownerTick(L + 136 * 60_000);
  expect(oa.goalById(g)!.status).toBe("stuck"); expect(notified.map((x) => x.kind)).toEqual(["stuck"]);
  await oa.ownerTick(L + 140 * 60_000); expect(notified.length).toBe(1);
  const f = join(process.env.AGENTNET_HOME!, "m.png"); writeFileSync(f, "x");
  expect((await call(a.name, "POST", "/steps/done", { evidence: [`shot: ${f}`] })).status).toBe(200);
  await oa.ownerTick(Date.now() + 60_000);
  expect(oa.goalById(g)).toMatchObject({ status: "doing", stuck_level: 0 });
});

test("owner-asks: daily token cap stores over-budget messages unclassified", async () => {
  const small = { daily_token_cap: 500 }; // checked before each call: the first (0 used) runs, the second (767 used) does not
  expect(await oa.ingest(msg("70", "first real request about the backup job"), small, T0)).not.toBeNull();
  expect(await oa.ingest(msg("71", "second real request about the photos app"), small, T0)).toBeNull();
  expect(calls.length).toBe(1);
  const row = db().query("SELECT kind, about FROM owner_msgs WHERE msg_id = '71'").get() as { kind: string; about: string };
  expect(row).toEqual({ kind: "skip", about: "over budget" });
  expect(toRoot().filter((m) => m.subject.includes("token cap")).length).toBe(1);
  void dir;
});

test("owner-asks: panel lists goals with items; owner marks wrong, not wanted and missing tell root; heart is a praise event", async () => {
  const { asksPanelRoutes } = await import("../src/net/asksPanel");
  const papi = new Hono<Env>(); asksPanelRoutes(papi); const panel = new Hono<Env>(); panel.route("/api/v1", papi);
  const P = (method: string, path: string, body?: unknown) => j(panel.request(`/api/v1/agentnet-panel${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));
  const events: string[] = []; oa.learnFns.push((e) => events.push(`${e.type}:${e.mark ?? ""}`));
  const g = (await oa.ingest(msg("80", "fix the desks and the lamp in the office"), cfg, T0))!;
  await agent(["desks", "lamp", "monitors"], `Goal: G${g}\n`);
  const list = await P("GET", "/goals");
  expect(list.body.on).toBe(true);
  const goal = list.body.goals.find((x: { id: number }) => x.id === g);
  expect(goal.items.map((i: { text: string }) => i.text)).toEqual(["desks", "lamp", "monitors"]);
  const [, lamp, mon] = goal.items as { id: number }[];
  expect((await P("POST", `/items/${mon!.id}/mark`, { mark: "unwanted" })).status).toBe(200);
  expect((await P("POST", `/items/${lamp!.id}/mark`, { mark: "wrong" })).status).toBe(200);
  expect((await P("POST", `/items/${lamp!.id}/mark`, { mark: "bogus" })).status).toBe(422);
  expect((await P("POST", `/goals/${g}/missing`, { text: "the door" })).status).toBe(200);
  expect((await P("POST", `/goals/${g}/heart`)).status).toBe(200);
  expect((await P("POST", `/goals/9999/heart`)).status).toBe(404);
  const items = oa.itemsOf(g);
  expect(items.find((i) => i.id === mon!.id)).toMatchObject({ status: "dropped", mark: "unwanted" });
  oa.syncGoal(g); // a sync must not bring the owner's drop back
  expect(oa.itemsOf(g).find((i) => i.id === mon!.id)!.status).toBe("dropped");
  expect(items.find((i) => i.text === "the door")).toMatchObject({ origin: "owner", mark: "missing", status: "open" });
  expect(toRoot().filter((m) => m.subject.startsWith(`G${g}: owner`)).length).toBe(3);
  expect(events).toEqual(["mark:unwanted", "mark:wrong", "mark:missing", "praise:"]);
  oa.learnFns.length = 0;
});

test("owner-asks: pushes are batched per tick with one retry; the digest goes once a day after its time, only when a goal changed", async () => {
  const sent: string[] = []; let ok = false; const realSend = oa.ownerDeps.send, realNotify = oa.ownerDeps.notify;
  oa.ownerDeps.send = (md) => { sent.push(md); return ok; }; oa.ownerDeps.notify = (_k, _g, md) => oa.queueNotify(md); oa._resetNotify();
  try {
    oa.queueNotify("a"); oa.queueNotify("b");
    expect(oa.flushNotify()).toBe(0); expect(sent).toEqual(["a\n\nb"]);
    ok = true; expect(oa.flushNotify()).toBe(2); expect(oa.flushNotify()).toBe(0);
    ok = false; oa.queueNotify("c"); oa.flushNotify(); oa.flushNotify(); oa.flushNotify();
    expect(sent.filter((s) => s === "c").length).toBe(2); // first try plus one retry, then dropped
    sent.length = 0; ok = true;
    const day = new Date(2026, 10, 18, 21, 0).getTime();
    expect(oa.digestTick(day, "21:30")).toBeNull(); // before the time
    expect(oa.digestTick(day + 31 * 60_000, "21:30")).toBeNull(); // nothing changed today
    const d2 = new Date(2026, 10, 19, 10, 0).getTime();
    await oa.ingest(msg("90", "add a evening summary of the asks"), cfg, d2);
    const md = oa.digestTick(d2 + 12 * 3_600_000, "21:30")!;
    expect(md).toContain("1 without a job"); expect(md).toContain("evening summary");
    expect(oa.digestTick(d2 + 13 * 3_600_000, "21:30")).toBeNull(); // once a day
    expect(sent.length).toBe(1);
  } finally { oa.ownerDeps.send = realSend; oa.ownerDeps.notify = realNotify; oa._resetNotify(); }
});

test("owner-asks: a follow-up detail lands as an owner item on its open goal; coverage compares his words with the brief items", async () => {
  reply = (_s, input) => input.includes("His open goals") ? `{"kind":"goal","list":[],"about":null,"follow_up":${/^(\d+):/m.exec(input.split("His open goals:\n")[1]!)![1]}}` : '{"kind":"goal","list":[],"about":null}';
  const g = (await oa.ingest(msg("95", "set up the daily brief for the stock bot with charts"), cfg, T0))!;
  expect(await oa.ingest(msg("96", "make the chart wider so support and resistance are not tight"), cfg, T0 + 60_000)).toBe(g);
  expect(goals().length).toBe(1);
  expect(oa.itemsOf(g).map((i) => [i.origin, i.text])).toEqual([["owner", "make the chart wider so support and resistance are not tight"]]);
  expect(calls[1]).toContain(`${g}: set up the daily brief`);
  await agent(["brief job", "charts"], `Goal: G${g}\n`);
  let seen = ""; reply = (system, input) => { if (system.includes("to-do items")) seen = input; return '{"uncovered":[]}'; };
  await oa.coverageTick(Date.now() + 60_000);
  expect(seen).toContain("make the chart wider"); expect(seen.split("Items:")[1]).not.toContain("make the chart wider");
});
test("owner-asks: an owner item added after the brief items never takes a step that has an item (no unique-key crash)", async () => {
  const g = (await oa.ingest(msg("97", "redraw the agents map with rounded cards and motion"), cfg, T0))!;
  await agent(["redraw the agents map with rounded cards", "motion on state change"], `Goal: G${g}\n`);
  expect(oa.itemsOf(g).map((i) => [i.origin, i.step_n])).toEqual([["brief", 1], ["brief", 2]]);
  const it = oa.ownerMissing(g, "redraw the agents map with rounded cards and soft lines");
  expect("error" in it).toBe(false);
  expect(() => oa.syncGoal(g)).not.toThrow();
  expect(oa.itemsOf(g).find((i) => i.origin === "owner")!.step_n).toBeNull();
});
test("owner-asks: a follow-up that names nothing of its goal starts a new goal", async () => {
  reply = (_s, input) => input.includes("His open goals") ? `{"kind":"goal","list":[],"about":null,"follow_up":${/^(\d+):/m.exec(input.split("His open goals:\n")[1]!)![1]}}` : '{"kind":"goal","list":[],"about":null}';
  const g = (await oa.ingest(msg("97", "https://x.com/someone/status/1 look at this tool"), cfg, T0))!;
  const h = (await oa.ingest(msg("98", "cards almost borderless on the dashboard"), cfg, T0 + 60_000))!;
  expect(h).not.toBe(g); expect(oa.itemsOf(g)).toHaveLength(0);
  // a goal from yesterday is not offered as an open goal for today's message
  calls = []; await oa.ingest(msg("99", "make the office lamps warmer", T0 + 8 * 3_600_000), cfg, T0 + 8 * 3_600_000);
  expect(calls[0]).not.toContain("His open goals");
});
test("owner-asks: the page view shows proof lines without the home and projects prefix", async () => {
  const g = (await oa.ingest(msg("120", "ship the trail page with real proof lines"), cfg, T0))!;
  db().run("INSERT INTO owner_items (goal_id, origin, text, status, proof, at) VALUES (?, 'brief', 'x', 'done', ?, ?)", [g, "commit: ab12cd3 /Users/someone/projects/app; shot: /home/u/projects/app/docs/a.png", T0]);
  expect(oa.goalsView().find((x) => x.id === g)!.items[0]!.proof).toBe("commit: ab12cd3 app; shot: app/docs/a.png");
});
test("owner-asks: a blocked report while the agent keeps calling tools does not jump the stall ladder; a real block does", async () => {
  const g = (await oa.ingest(msg("130", "tune the card difficulty for four rounds"), cfg, T0))!;
  const a = await agent(["tune", "rounds"], `Goal: G${g}\n`);
  const L = oa.linksOf(g)[0]!.at, ev = (type: string, data: Record<string, unknown>, ts: number) => { st.emit({ agent: a.id, type, data, source: "mcp", ts }); st.flush(); };
  ev("StatusReported", { phase: "blocked", blockedOn: "upgrade hook refused proof" }, L + 5 * 60_000);
  ev("ToolFinished", { tool: "Bash", target: "bun test" }, L + 6 * 60_000);
  await oa.ownerTick(L + 10 * 60_000);
  expect(toRoot().filter((m) => m.subject === `G${g} stalling`).length).toBe(0);
  ev("StatusReported", { phase: "blocked", blockedOn: "waiting for root" }, L + 12 * 60_000);
  await oa.ownerTick(L + 15 * 60_000);
  expect(toRoot().filter((m) => m.subject === `G${g} stalling`).length).toBe(1);
});
test("owner-asks: root links a finished (archived) agent's closed job", async () => {
  const g = (await oa.ingest(msg("131", "write more drawn cards per company type"), cfg, T0))!;
  const a = await agent(["cards", "grid"]);
  db().run("UPDATE agents SET archived_at = ? WHERE id = ?", [T0 + 1, a.id]);
  expect((await call("root", "POST", `/owner-goals/${g}/link`, { agent: a.name })).status).toBe(200);
  expect(oa.linksOf(g).map((l) => l.agent)).toEqual([a.name]);
  expect(oa.itemsOf(g).filter((i) => i.origin === "brief")).toHaveLength(2);
});
