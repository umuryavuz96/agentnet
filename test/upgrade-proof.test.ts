// Step 8 proof fix: a hook proof counts only when the server finds its tool_use_id in the agent's own transcript and its own
// matchCheck passes (docs/internal/one-folder/SPEC-step8-proof.md). Scratch home, in-memory DBs, fixture transcripts in a
// scratch Claude home: no real transcript is read. Fixture names are made up.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-proof-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../src/core/db");
const { tracing } = await import("../src/core/http");
type Env = import("../src/core/http").Env;
const st = await import("../src/net/store");
const rt = await import("../src/net/routes");
const sc = await import("../src/net/scores");
const fin = await import("../src/net/finish");
const ln = await import("../src/net/lines");
const ac = await import("../src/net/agent-config");
const tr = await import("./helpers/transcript");
type FixtureCall = import("./helpers/transcript").FixtureCall;

const app = new Hono<Env>(); app.use("*", tracing); const api = new Hono<Env>(); rt.agentnetRoutes(api); app.route("/api/v1", api);
const tok: Record<string, string> = {};
const call = (who: string, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/agentnet${path}`, { method, headers: { authorization: `Bearer ${tok[who] ?? who}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const j = async (p: Response | Promise<Response>) => { const r = await p; return { status: r.status, body: await r.json().catch(() => null) as any }; };
fin.finishDeps.procs = { table: () => [], panePids: () => [], portPids: () => [], signal: () => {}, alive: () => true, later: (fn) => fn(), killSession: () => {} };

const CH = tr.scratchClaudeHome(), CWD = "/fixture/proof-work";
const on = () => { process.env.AGENTNET_LINES = "1"; };
const off = () => { delete process.env.AGENTNET_LINES; };
beforeAll(async () => {
  useDatabase(new Database(":memory:")); st._reset(); sc.useScoreDb(new Database(":memory:"));
  tok.root = rt.createAgent({ name: "root", job: "t", by: "test", standing: true }).token;
  await ln.registerLineHandlers();
});
afterAll(() => { off(); CH.restore(); });

const sessionOf: Record<string, string> = {};
const fileOf = (name: string) => tr.transcriptPath(CH.home, CWD, sessionOf[name]!);
async function spawn(name: string, steps = 1) {
  const made = rt.createAgent({ name, boss: "root", job: "t", goal: "g", by: "test", project: CWD }, Date.now() - 60_000);
  tok[name] = made.token; sessionOf[name] = `s-${made.id}`;
  await call(name, "POST", "/hello", { session: sessionOf[name], pid: 51_000 + made.id.length });
  rt.startJob(made.id, { by: "root", goal: "fixture job", steps: Array.from({ length: steps }, (_, i) => `outcome ${i + 1}`) });
  return made.id;
}
const UI = { tool: "Bash", command_includes: "ui-check.mjs", output_includes: "PASS" };
const upgrade = (name: string, scope = "before_report", check: unknown = UI, text = "Run ui-check on every page I touch before I report done.") => j(call(name, "POST", "/self-upgrade", { text, scope, check }));
let n = 0;
const nextId = () => `toolu_fixture${String(++n).padStart(4, "0")}`;
const claim = (name: string, tool_use_id: unknown) => j(call(name, "POST", "/upgrade-proof", { tool_use_id, evidence: "Bash: node ui-check.mjs => PASS" }));
const realRun = (name: string, extra: Partial<FixtureCall> = {}) => { const id = nextId(); tr.writeCall(fileOf(name), { id, tool: "Bash", input: { command: "node ui-check.mjs http://127.0.0.1:3000/" }, output: "ui-check: PASS 390x844 light", ...extra }); return id; };
const steps = async (name: string, k = 1) => { for (let i = 0; i < k; i++) expect((await call(name, "POST", "/steps/done", { evidence: ["check: bun test 9 pass 0 fail"] })).status).toBe(200); };
const report = (name: string) => j(call(name, "POST", "/report", { summary: `Done: ${name}.`, state: "done" }));
const rows = (name: string, gen = 1) => ln.allProofsOf(name, gen);

test("proof: hook claim without tool_use_id is 422; a repeated id is 409", async () => {
  on(); await spawn("pa-1"); expect((await upgrade("pa-1")).status).toBe(201);
  expect((await claim("pa-1", undefined)).status).toBe(422);
  expect((await claim("pa-1", "short")).status).toBe(422);
  expect((await claim("pa-1", "toolu_bad id;rm")).status).toBe(422);
  const id = realRun("pa-1");
  const first = await claim("pa-1", id);
  expect(first.status).toBe(201); expect(first.body.proof.status).toBe("verified");
  expect((await claim("pa-1", id)).status).toBe(409);
  expect(rows("pa-1")).toHaveLength(1);
});

test("proof: forged claim with an id not in the transcript is rejected and never opens the gate", async () => {
  on(); await spawn("pb-1"); expect((await upgrade("pb-1")).status).toBe(201);
  realRun("pb-1", { input: { command: "bun test" }, output: "9 pass" }); // some other real work in the transcript
  const forged = await claim("pb-1", "toolu_madeup0000001");
  expect(forged.status).toBe(201); expect(forged.body.proof.status).toBe("unverified");
  const r = await report("pb-1");
  expect(r.status).toBe(409); expect(r.body.detail).toContain("your upgrade is not proven yet");
  expect(ln.proofsOf("pb-1", 1)).toHaveLength(0);
  off(); expect((await report("pb-1")).status).toBe(200); // settle (final) runs on the despawn
  expect(rows("pb-1")[0]).toMatchObject({ status: "rejected", reason: "not in transcript" });
  expect(ln.upgradeOf("pb-1", 1)!.status).toBe("reverted");
  const view = await j(call("root", "GET", "/agent-lines/pb-1"));
  expect(view.status).toBe(200); expect(view.body.proofs[0]).toMatchObject({ status: "rejected", reason: "not in transcript", tool_use_id: "toolu_madeup0000001" });
  expect((await call("pa-1", "GET", "/agent-lines/pb-1")).status).toBe(403); // root only
});

test("proof: real ui-check PASS call in the transcript verifies and opens the gate", async () => {
  on(); await spawn("pc-1"); expect((await upgrade("pc-1")).status).toBe(201);
  expect((await report("pc-1")).status).toBe(409);
  const p = await claim("pc-1", realRun("pc-1"));
  expect(p.body.proof).toMatchObject({ status: "verified", source: "hook" });
  expect(p.body.proof.evidence).toMatch(/^Bash: node ui-check\.mjs .* => .*PASS 390x844/); // the server's own match, not the posted text
  expect((await report("pc-1")).status).toBe(200);
  expect(ln.upgradeOf("pc-1", 1)!.status).toBe("kept");
});

test("proof: id whose output does not match the check, or is an error result, is rejected", async () => {
  on(); await spawn("pd-1"); expect((await upgrade("pd-1")).status).toBe(201);
  const fail = await claim("pd-1", realRun("pd-1", { output: "ui-check: FAIL 390x844 sideways scroll" }));
  expect(fail.body.proof).toMatchObject({ status: "rejected", reason: "no match" });
  const err = await claim("pd-1", realRun("pd-1", { output: "ui-check: PASS 390x844", isError: true }));
  expect(err.body.proof).toMatchObject({ status: "rejected", reason: "error result" });
  const other = await claim("pd-1", realRun("pd-1", { input: { command: "bun test" }, output: "PASS" }));
  expect(other.body.proof).toMatchObject({ status: "rejected", reason: "no match" });
  expect((await report("pd-1")).status).toBe(409);
});

test("proof: call from before the upgrade was accepted is rejected", async () => {
  on(); await spawn("pe-1"); expect((await upgrade("pe-1")).status).toBe(201);
  const created = ln.upgradeOf("pe-1", 1)!.created;
  const old = await claim("pe-1", realRun("pe-1", { at: created - 5_000 }));
  expect(old.body.proof).toMatchObject({ status: "rejected", reason: "before upgrade" });
  expect((await report("pe-1")).status).toBe(409);
});

test("proof: print-only command in the transcript (echo PASS) is rejected (gaming guard on the server copy)", async () => {
  on(); await spawn("pf-1"); expect((await upgrade("pf-1")).status).toBe(201);
  for (const command of ["echo 'node ui-check.mjs PASS'", "printf 'ui-check.mjs PASS\\n'", "echo ui-check.mjs"]) {
    const p = await claim("pf-1", realRun("pf-1", { input: { command }, output: "node ui-check.mjs PASS" }));
    expect(p.body.proof).toMatchObject({ status: "rejected", reason: "no match" });
  }
  expect(ln.proofsOf("pf-1", 1)).toHaveLength(0);
});

test("proof: claim posted before the transcript has the call verifies at gate time; still missing at settle is rejected", async () => {
  on(); await spawn("pg-1"); expect((await upgrade("pg-1")).status).toBe(201);
  const late = nextId(), never = nextId();
  tr.writeCall(fileOf("pg-1"), { id: late, tool: "Bash", input: { command: "node ui-check.mjs http://127.0.0.1:3000/" }, result: false }); // the call row, no result yet
  expect((await claim("pg-1", late)).body.proof.status).toBe("unverified");
  expect((await claim("pg-1", never)).body.proof.status).toBe("unverified");
  expect((await report("pg-1")).status).toBe(409); // the result is not in yet
  tr.writeResult(fileOf("pg-1"), late, "ui-check: PASS 1920x1080 dark");
  expect((await report("pg-1")).status).toBe(200); // the gate checked again and found it
  const byId = Object.fromEntries(rows("pg-1").map((r) => [r.tool_use_id, r]));
  expect(byId[late]).toMatchObject({ status: "verified" });
  expect(byId[never]).toMatchObject({ status: "rejected", reason: "not in transcript" });
});

test("proof: agent route refused for a non-judgment check; accepted at half weight for judgment", async () => {
  on(); await spawn("ph-1"); expect((await upgrade("ph-1")).status).toBe(201);
  const r = await j(call("ph-1", "POST", "/upgrade-proof/agent", { evidence: "I ran it, trust me" }));
  expect(r.status).toBe(409); expect(r.body.detail).toContain("agent proof is only for judgment checks");
  expect(rows("ph-1")).toHaveLength(0);
  await spawn("pi-1", 2);
  expect((await upgrade("pi-1", "every_step", { judgment: true }, "Ask myself whether the change is the smallest that works.")).status).toBe(201);
  const a = await j(call("pi-1", "POST", "/upgrade-proof/agent", { evidence: "kept the diff to one file" }));
  expect(a.status).toBe(201); expect(a.body.proof).toMatchObject({ source: "agent", status: "verified" });
  expect(ln.adheres(ln.proofsOf("pi-1", 1))).toBe(false); // one agent proof is half
  await steps("pi-1");
  await Bun.sleep(2); expect((await j(call("pi-1", "POST", "/upgrade-proof/agent", { evidence: "one file again" }))).status).toBe(201);
  expect(ln.adheres(ln.proofsOf("pi-1", 1))).toBe(true);
});

test("proof: settle adherence counts only verified rows", async () => {
  on(); await spawn("pj-1"); expect((await upgrade("pj-1")).status).toBe(201);
  await claim("pj-1", "toolu_madeup0000002"); // never in the transcript
  await claim("pj-1", realRun("pj-1", { output: "ui-check: FAIL" })); // in it, no match
  expect(rows("pj-1").map((r) => r.status).sort()).toEqual(["rejected", "unverified"]);
  off(); await steps("pj-1"); expect((await report("pj-1")).status).toBe(200); // lines off at the gate: settle still runs on the despawn
  expect(rows("pj-1").every((r) => r.status === "rejected")).toBe(true);
  const v = ln.upgradeOf("pj-1", 1)!;
  expect(v.status).toBe("reverted"); expect(v.adherence).toBe(0);
  const l = ln.readLine("pj-1")!;
  expect(readFileSync(join(ln.selfDir("pj-1", l.current), "lessons.md"), "utf8")).toContain("Upgrade not followed: Run ui-check");
});

test("config: agent settings deny Write and Edit of its own projects/ and sessions/", () => {
  const d = ac.ownTranscriptDeny("pk-1");
  for (const tool of ["Edit", "Write"]) for (const rel of ["projects", "sessions"])
    expect(d.some((x) => x.startsWith(`${tool}(/`) && x.endsWith(`/agents/pk-1/claude/${rel}/**)`))).toBe(true);
  expect(d.some((x) => x.startsWith("Read("))).toBe(false); // the agent may still read its own transcript
  ac.prepareConfig("pk-1", { project: CWD, mcp: [] });
  const s = JSON.parse(readFileSync(join(ac.agentConfigDir("pk-1"), "settings.json"), "utf8")) as { permissions: { deny: string[] } };
  for (const x of d) expect(s.permissions.deny).toContain(x);
});

test("proof: a claim from session A still verifies after the agent moved to session B; another agent's session never counts", async () => {
  on(); await spawn("pl-1"); await spawn("pm-1"); expect((await upgrade("pl-1")).status).toBe(201);
  const fileA = fileOf("pl-1"), idA = nextId();
  tr.writeCall(fileA, { id: idA, tool: "Bash", input: { command: "node ui-check.mjs http://127.0.0.1:3000/" }, result: false });
  expect((await claim("pl-1", idA)).body.proof.status).toBe("unverified"); // posted in session A, result not written yet
  // the other agent's real ui-check run, in its own session
  const idOther = realRun("pm-1");
  expect((await claim("pl-1", idOther)).body.proof.status).toBe("unverified");
  // /clear: pl-1 says hello under session B; then tries to name pm-1's session as its own
  sessionOf["pl-1"] = "s-pl-1-after-clear";
  await call("pl-1", "POST", "/hello", { session: sessionOf["pl-1"], pid: 52_001 });
  await call("pl-1", "POST", "/hello", { session: sessionOf["pm-1"], pid: 52_002 });
  expect(ln.sessionsOf(rt.byName("pl-1")!.id)).toEqual([`s-${rt.byName("pl-1")!.id}`, "s-pl-1-after-clear"]); // pm-1's session stays pm-1's
  tr.writeResult(fileA, idA, "ui-check: PASS 390x844"); // session A's file gets the result after the move
  await call("pl-1", "POST", "/hello", { session: "s-pl-1-after-clear", pid: 52_001 });
  expect((await report("pl-1")).status).toBe(200);
  const byId = Object.fromEntries(rows("pl-1").map((r) => [r.tool_use_id, r]));
  expect(byId[idA]).toMatchObject({ status: "verified" });
  expect(byId[idOther]).toMatchObject({ status: "rejected", reason: "not in transcript" });
});

test("lines view: GET /v1/admin/agent-lines/{line} maps to the root-only read route; an agent token is 403", async () => {
  const { toLegacy } = await import("../src/net/mount");
  expect(toLegacy("/v1/admin/agent-lines/pb-1")).toBe("/api/v1/agentnet/agent-lines/pb-1");
  expect((await call("pa-1", "GET", "/agent-lines/pa-1")).status).toBe(403); // not even its own line
  const r = await j(call("root", "GET", "/agent-lines/pa-1"));
  expect(r.status).toBe(200); expect(r.body.versions).toHaveLength(1); expect(r.body.proofs[0]).toMatchObject({ status: "verified", source: "hook" });
  expect((await call("root", "GET", "/agent-lines/no-such-line")).status).toBe(404);
});
