import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-agentnet-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../core/db");
const st = await import("./store");
const rt = await import("./routes");
const sm = await import("./stream");
type Env = import("../core/http").Env;

const wn = await import("./windows");
// the agent routes are mounted FIRST here on purpose: the panel routes must still answer without an agent token
const app = new Hono<Env>(); const api = new Hono<Env>(); rt.agentnetRoutes(api); sm.agentnetStreamRoutes(api); wn.agentnetWindowRoutes(api); app.route("/api/v1", api);
beforeAll(() => { useDatabase(new Database(":memory:")); st._reset(); });

test("mergePatch: changed keys only, null for removed", () => {
  expect(sm.mergePatch(null, { a: 1 })).toEqual({ a: 1 });
  expect(sm.mergePatch({ a: 1, b: { x: 1 }, c: 3 }, { a: 1, b: { x: 2 } })).toEqual({ b: { x: 2 }, c: null });
});
test("snapshot and stream need no agent token; frames carry id and data.prev; gone is its own frame", async () => {
  const root = rt.createAgent({ name: "root", by: "t" }), w = rt.createAgent({ name: "w-1", boss: "root", by: "t" });
  expect((await app.request("/api/v1/agentnet/agents/w-1/open", { method: "POST" })).status).toBe(404); // panel route reached: no tmux session, not 401
  expect((await app.request("/api/v1/agentnet/windows/close-all", { method: "POST" })).status).toBe(200);
  const snap = await (await app.request("/api/v1/agentnet/snapshot")).json();
  expect(Object.keys(snap.agents).sort()).toEqual(["root#1", "w-1#1"]); expect(snap.seq).toBe(2);
  const res = await app.request("/api/v1/agentnet/stream");
  expect(res.status).toBe(200);
  const reader = res.body!.getReader(), dec = new TextDecoder(); let buf = "";
  const readUntil = async (n: number) => { while ((buf.match(/^event:/gm) ?? []).length < n) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } };
  const parse = () => buf.split("\n\n").filter((b) => /^event:/m.test(b)).map((b) => ({ id: Number(b.match(/^id: (\d+)/m)?.[1]), event: b.match(/^event: (\w+)/m)![1], data: JSON.parse(b.match(/^data: (.*)/m)![1]) }));
  await readUntil(1);
  expect(parse()[0]).toMatchObject({ id: 2, event: "hello" });
  await app.request("/api/v1/agentnet/hello", { method: "POST", headers: { authorization: `Bearer ${w.token}`, "content-type": "application/json" }, body: JSON.stringify({ session: "s", pid: 1 }) });
  await app.request("/api/v1/agentnet/send", { method: "POST", headers: { authorization: `Bearer ${root.token}`, "content-type": "application/json" }, body: JSON.stringify({ to: "w-1", body: "hi" }) });
  await app.request("/api/v1/agentnet/bye", { method: "POST", headers: { authorization: `Bearer ${w.token}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "exit" }) });
  await readUntil(6);
  await app.request("/api/v1/agentnet/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "root", body: "admin to root: no agent row on either side" }) }, { requestIP: () => ({ address: "127.0.0.1" }) });
  await readUntil(7);
  const frames = parse();
  expect(frames.slice(0, 6).map((f) => f.event)).toEqual(["hello", "agent", "msg", "agent", "agent", "gone"]); // msg comes from the send itself, before the sender's row patch
  expect(frames[2].data).toMatchObject({ id: 1, from: "root", to: "w-1", kind: "info", subject: "hi", body: "hi", reply_to: null, state: "queued" }); // the whole row: the page threads it at once
  expect(frames[1].data.patch.life).toBe("live"); expect(frames[1].data.prev).toBe(2); expect(frames[1].id).toBe(3);
  for (let i = 2; i < frames.length; i++) expect(frames[i].data.prev).toBe(frames[i - 1].id);
  expect(frames[5].data).toMatchObject({ id: "w-1#1", reason: "exit" });
  expect(frames[6]).toMatchObject({ event: "msg", data: { from: "root", to: "root", state: "queued" } }); // a sender and receiver without rows still make a frame
  await reader.cancel();
});
