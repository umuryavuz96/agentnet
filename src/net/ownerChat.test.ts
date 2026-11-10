import { beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oc-"));
process.env.AGENTNET_HOME ??= dir;
process.env.AGENTNET_CLAUDE_HOME = join(dir, "claude");
delete process.env.TMUX;
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../core/db");
const { tracing } = await import("../core/http");
type Env = import("../core/http").Env;
const st = await import("./store");
const rt = await import("./routes");
const oc = await import("./ownerChat");
const wn = await import("./windows");
const { projectDir, sent } = await import("./feed");

const calls: string[][] = [], sessions = new Set<string>(["agentnet-oc-1"]);
let failPaste = false;
const tmux: import("./windows").Tmux = { run: (a) => {
  calls.push(a);
  if (a[0] === "has-session") return { code: sessions.has(a[2]!.replace(/^=/, "")) ? 0 : 1, out: "" };
  if (a[0] === "paste-buffer" && failPaste) return { code: 1, out: "" };
  return { code: 0, out: "" };
} };
const app = new Hono<Env>(); app.use("*", tracing); const api = new Hono<Env>(); oc.ownerChatRoutes(api, { tmux, sleep: async () => {}, tickMs: 20 }); app.route("/api/v1", api);
const post = (name: string, body: unknown) => app.request(`/api/v1/agentnet/agents/${name}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  useDatabase(new Database(":memory:")); st._reset(); calls.length = 0; failPaste = false; sessions.clear(); sessions.add("agentnet-oc-1");
  rt.createAgent({ name: "oc-1", boss: "root", job: "t", by: "test", project: "/work/oc-proj" });
});

describe("POST /prompt", () => {
  test("types with a bracketed paste, then Enter, into the exact session", async () => {
    const r = await post("oc-1", { text: "line one\nline two", nonce: "n-1" });
    expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ sent: true, nonce: "n-1" });
    expect(calls.filter((c) => c[0] !== "has-session")).toEqual([
      ["set-buffer", "-b", expect.stringContaining("agentnet-prompt"), "--", "line one\nline two"],
      ["paste-buffer", "-p", "-d", "-b", expect.stringContaining("agentnet-prompt"), "-t", "=agentnet-oc-1:"],
      ["send-keys", "-t", "=agentnet-oc-1:", "Enter"],
    ]);
    expect(sent.pending("oc-1").map((e) => e.nonce)).toContain("n-1");
  });
  test("NO_TERMINAL (409) when the agent has no tmux session; nothing is typed", async () => {
    sessions.clear();
    const r = await post("oc-1", { text: "hi" });
    expect(r.status).toBe(409); const j = await r.json() as { code: string; detail: string };
    expect(j.code).toBe("NO_TERMINAL"); expect(j.detail).toContain("cannot type into");
    expect(calls.some((c) => c[0] === "paste-buffer")).toBe(false);
  });
  test("the director with no tmux session is NO_TERMINAL and offers Move director", async () => {
    const r = await post("root", { text: "hi" });
    expect(r.status).toBe(409); expect((await r.json() as { detail: string }).detail).toContain("Move director");
  });
  test("the director in agentnet-root gets the text", async () => {
    sessions.add(wn.rootSession());
    expect((await post("root", { text: "as the owner" })).status).toBe(200);
    expect(calls.find((c) => c[0] === "paste-buffer")).toContain(`=${wn.rootSession()}:`);
  });
  test("404 unknown agent, 422 empty / over 8 kB / bad name, 502 when tmux refuses", async () => {
    expect((await post("nobody", { text: "x" })).status).toBe(404);
    expect((await post("oc-1", { text: "   " })).status).toBe(422);
    expect((await post("oc-1", { text: "x".repeat(8193) })).status).toBe(422);
    expect((await post("BAD_NAME", { text: "x" })).status).toBe(422);
    failPaste = true; expect((await post("oc-1", { text: "x" })).status).toBe(502);
  });
});

describe("GET /feed", () => {
  test("reset with the transcript items, then only the new ones; pending shows a send until the transcript has it", async () => {
    const cwd = "/work/oc-proj", pd = projectDir(cwd); mkdirSync(pd, { recursive: true });
    const f = join(pd, "sess-1.jsonl");
    writeFileSync(f, JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-11-10T10:00:00Z", message: { content: [{ type: "text", text: "hello owner" }] } }) + "\n");
    const a = st.live().find((x) => x.name === "oc-1")!;
    st.emit({ agent: a.id, type: "AgentConnected", data: { session: "sess-1", pid: 1 }, source: "mod", ts: Date.now() }); st.flush();
    expect(st.live().find((x) => x.name === "oc-1")).toMatchObject({ session: "sess-1", project: cwd });
    sent.add("oc-1", "next", "nz");
    const res = await app.request("/api/v1/agentnet/agents/oc-1/feed");
    const reader = res.body!.getReader(), dec = new TextDecoder(); let buf = "";
    const until = async (re: RegExp) => { const end = Date.now() + 3000; while (!re.test(buf) && Date.now() < end) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } return re.test(buf); };
    expect(await until(/event: reset[\s\S]*hello owner/)).toBe(true);
    expect(buf).toContain('"sending":true');
    appendFileSync(f, JSON.stringify({ type: "user", uuid: "u9", timestamp: new Date().toISOString(), origin: { kind: "human" }, message: { content: "next" } }) + "\n");
    expect(await until(/event: items[\s\S]*"nonce":"nz"/)).toBe(true);
    await reader.cancel();
  });
});
