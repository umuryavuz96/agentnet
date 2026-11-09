import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-agentnet-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../core/db");
const { tracing } = await import("../core/http");
type Env = import("../core/http").Env;
const st = await import("./store");
const rt = await import("./routes");
const ck = await import("./checks");
const { checksPanelRoutes } = await import("./checksPanel");
const { toLegacy } = await import("./mount");

const app = new Hono<Env>(); app.use("*", tracing); const api = new Hono<Env>(); checksPanelRoutes(api); rt.agentnetRoutes(api); app.route("/api/v1", api);
const tok: Record<string, string> = {};
const call = (who: string, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${tok[who] ?? who}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
const Q = "Do you see a Voice button in a bot's header on the iPad?";
const OPTS: { label: string; tone: "good" | "bad" | "neutral" }[] = [{ label: "Yes, it's there", tone: "good" }, { label: "No button", tone: "bad" }, { label: "Not sure", tone: "neutral" }];

beforeAll(() => {
  useDatabase(new Database(":memory:")); st._reset();
  for (const [name, boss] of [["root", null], ["web-dev-1", "root"], ["qa-1", "root"]] as const) tok[name] = rt.createAgent({ name, boss: boss ?? undefined, job: "t", by: "test" }).token;
});

describe("store", () => {
  test("options: none = Works / Not yet; 2-4 with labels and tones", () => {
    expect(ck.parseOptions(undefined)).toEqual([{ label: "Works", tone: "good" }, { label: "Not yet", tone: "bad" }]);
    expect(ck.parseOptions(OPTS)).toEqual(OPTS);
    for (const bad of [[], [OPTS[0]], [...OPTS, ...OPTS], [{ label: "", tone: "good" }, OPTS[1]], [{ label: "x", tone: "red" }, OPTS[1]], [OPTS[0], { label: "yes, IT'S there", tone: "bad" }], [{ label: "one two three four five six seven", tone: "good" }, OPTS[1]], "yes"]) expect(typeof ck.parseOptions(bad)).toBe("string");
  });
});

describe("routes", () => {
  test("agent asks for itself; defaults; same open question is not stacked; an agent cannot ask for another", async () => {
    const a = await j(await call("web-dev-1", "POST", "/agentnet/checks", { question: Q, options: OPTS, detail: "open Settings" }));
    expect(a.status).toBe(201); expect(a.body.check).toMatchObject({ agent: "web-dev-1", state: "pending", options: OPTS, createdBy: "web-dev-1", answer: null });
    const dup = await j(await call("web-dev-1", "POST", "/agentnet/checks", { question: Q }));
    expect(dup.status).toBe(200); expect(dup.body.check.id).toBe(a.body.check.id);
    expect((await j(await call("web-dev-1", "POST", "/agentnet/checks", { question: "x", agent: "qa-1" }))).body.check?.agent ?? "web-dev-1").toBe("web-dev-1"); // body.agent ignored for non-root
    const d = await j(await call("qa-1", "POST", "/agentnet/checks", { question: "Does the TV show the logo?" }));
    expect(d.body.check.options.map((o: { label: string }) => o.label)).toEqual(["Works", "Not yet"]);
    expect((await j(await call("qa-1", "POST", "/agentnet/checks", { question: "" }))).status).toBe(422);
    expect((await j(await call("qa-1", "POST", "/agentnet/checks", { question: "ok?", options: [OPTS[0]] }))).status).toBe(422);
  });
  test("root asks for a despawned agent; list is root-wide, an agent sees its own", async () => {
    const r = await j(await call("root", "POST", "/agentnet/checks", { agent: "ghost-1", question: "Is the light on?" }));
    expect(r.status).toBe(201); expect(r.body.check.agent).toBe("ghost-1"); expect(r.body.check.createdBy).toBe("root");
    expect((await j(await call("root", "GET", "/agentnet/checks?state=pending"))).body.checks.length).toBe(4);
    expect((await j(await call("qa-1", "GET", "/agentnet/checks"))).body.checks.map((c: { agent: string }) => c.agent)).toEqual(["qa-1"]);
  });
  test("resolve: stores chosen label and tone, tells root from owner, 409 twice, 422 unknown option, 404", async () => {
    const id = ck.listChecks("pending").find((c) => c.agent === "web-dev-1")!.id;
    expect((await j(await call("root", "POST", `/agentnet-panel/checks/${id}/resolve`, { option: "Maybe" }))).status).toBe(422);
    const ok = await j(await call("root", "POST", `/agentnet-panel/checks/${id}/resolve`, { option: "No button", note: "only on the lock screen" }));
    expect(ok.status).toBe(200); expect(ok.body.check).toMatchObject({ state: "answered", answer: "No button", answerTone: "bad", note: "only on the lock screen" }); expect(ok.body.check.resolvedAt).toBeGreaterThan(0);
    expect((await j(await call("root", "POST", `/agentnet-panel/checks/${id}/resolve`, { option: 0 }))).status).toBe(409);
    expect((await j(await call("root", "POST", `/agentnet-panel/checks/999/resolve`, { option: 0 }))).status).toBe(404);
    const msg = (await j(await call("root", "POST", "/agentnet/inbox", {}))).body.messages.find((m: { subject: string }) => m.subject.startsWith("Owner answered"));
    expect(msg).toMatchObject({ from: "owner", kind: "report" }); expect(msg.subject).toBe(`Owner answered "No button": ${Q}`.slice(0, 60));
    expect(msg.body).toContain(`Owner answered "No button": ${Q}`); expect(msg.body).toContain("only on the lock screen");
  });
  test("answer by index works on a default check; never changes agents (no despawn)", async () => {
    const id = ck.listChecks("pending").find((c) => c.agent === "qa-1")!.id;
    expect((await j(await call("root", "POST", `/agentnet-panel/checks/${id}/resolve`, { option: 0 }))).body.check).toMatchObject({ answer: "Works", answerTone: "good" });
    expect(st.get("qa-1#1")?.life).not.toBe("gone");
    expect((await j(await call("root", "GET", "/agentnet-panel/checks?state=answered"))).body.checks.length).toBe(2);
  });
  test("a root that is gone still gets the answer (loopback inbox), nothing is dropped", async () => {
    st.emit({ agent: "root#1", type: "AgentGone", data: { reason: "despawn" }, source: "service" }); st.flush();
    const k = ck.createCheck({ agent: "web-dev-1", question: "Is the light blue?", by: "root" }); if ("error" in k) throw new Error(k.error);
    const r = await j(await call("root", "POST", `/agentnet-panel/checks/${k.check.id}/resolve`, { option: "Works" }));
    expect(r.status).toBe(200); expect(r.body.message).toBeGreaterThan(0);
  });
  test("snapshot window: answered checks stay visible 30 s, then leave", () => {
    const now = Date.now();
    expect(ck.visibleChecks(now).some((c) => c.state === "answered")).toBe(true);
    expect(ck.visibleChecks(now + ck.SHOW_RESOLVED_MS + 1000).some((c) => c.state === "answered")).toBe(false);
    expect(ck.visibleChecks(now).some((c) => c.agent === "ghost-1")).toBe(true); // pending stays with no agent row
  });
  test("v1 paths rewrite", () => {
    expect(toLegacy("/v1/agent/checks")).toBe("/api/v1/agentnet/checks");
    expect(toLegacy("/v1/panel/checks")).toBe("/api/v1/agentnet-panel/checks");
    expect(toLegacy("/v1/panel/checks/7/resolve")).toBe("/api/v1/agentnet-panel/checks/7/resolve");
  });
});
