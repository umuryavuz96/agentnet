// A root row left by a failed setup (joined, never connected) must not block a new director join.
import { expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-ghost-"));
const { Database } = await import("bun:sqlite");
const { useDatabase } = await import("../core/db");
const st = await import("./store");
const rt = await import("./routes");

beforeEach(() => { useDatabase(new Database(":memory:")); st._reset(); rt.ghostDeps.pidAlive = () => true; rt.ghostDeps.hasSession = () => true; });
const hello = (id: string, pid: number) => { st.emit({ agent: id, type: "AgentConnected", data: { session: "s", pid }, source: "service" }); st.flush(); };

test("starting root older than 60 s that never connected is replaced", () => {
  const t0 = Date.now() - 120_000;
  rt.createAgent({ name: "root", by: "t" }, t0);
  const n = rt.createAgent({ name: "root", by: "t" });
  expect(n.id).toBe("root#2");
  expect(st.get("root#1")?.life).toBe("gone"); expect(st.get("root#1")?.goneReason).toBe("replaced");
});
test("fresh starting root still blocks", () => {
  rt.createAgent({ name: "root", by: "t" }, Date.now() - 10_000);
  expect(() => rt.createAgent({ name: "root", by: "t" })).toThrow("root is live already");
});
test("connected live root with a live process still blocks", () => {
  const a = rt.createAgent({ name: "root", by: "t" }, Date.now() - 120_000); hello(a.id, 4242);
  rt.ghostDeps.hasSession = () => false; // not in tmux, but the process is alive
  expect(() => rt.createAgent({ name: "root", by: "t" })).toThrow("root is live already");
});
test("connected root whose process and session are gone is replaced", () => {
  const a = rt.createAgent({ name: "root", by: "t" }, Date.now() - 120_000); hello(a.id, 4242);
  rt.ghostDeps.pidAlive = () => false; rt.ghostDeps.hasSession = () => false;
  expect(rt.createAgent({ name: "root", by: "t" }).id).toBe("root#2");
});
test("other names are never replaced this way", () => {
  rt.createAgent({ name: "qa-9", by: "t" }, Date.now() - 120_000);
  expect(() => rt.createAgent({ name: "qa-9", by: "t" })).toThrow("live already");
});
