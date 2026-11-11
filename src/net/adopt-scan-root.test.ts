// The adopt scan session joins as "root". Apply stops it, and the director that starts next must be able to join as "root".
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOP } from "../../test/helpers";
import { makeWorkspace } from "../../test/helpers/adoptFixture";

const tmp = mkdtempSync(join(tmpdir(), "an-adopt-root-"));
const { ws, home } = makeWorkspace(tmp);
const ENV = ["AGENTNET_HOME", "AGENTNET_WORKSPACE_DIR", "HOME", "AGENTNET_ADOPT_STUB", "TMUX"];
const old: Record<string, string | undefined> = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
process.env.AGENTNET_HOME = join(tmp, "agentnet"); process.env.AGENTNET_WORKSPACE_DIR = join(tmp, "agentnet", "workspace"); process.env.HOME = home; delete process.env.TMUX;
mkdirSync(process.env.AGENTNET_HOME, { recursive: true });
afterAll(async () => {
  await Bun.sleep(1100); // run ids are timestamped to the second; the next adopt test shares this home
  Object.assign(seams, saved); // the module is shared with the other adopt tests
  try { await call("/v1/panel/adopt/rollback", {}); } catch { /* none */ }
  setState({ phase: "idle", scanner: null, mode: null, workspace: null, scanId: null, planId: null, runId: null, error: null }); for (const k of ENV) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } });
const { buildApp, makeFetch } = await import("../server");
{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../core/db"); useDatabase(new Database(":memory:")); (await import("./store"))._reset(); }
const { seams, setState } = await import("./adopt");
const rt = await import("./routes");
const st = await import("./store");

let directorJoin: string | Error = "";
const saved = { ...seams };
seams.startDirector = (() => { try { directorJoin = rt.createAgent({ name: "root", by: "t" }).id; } catch (e) { directorJoin = e as Error; } return { ok: true, session: "x", attach: "" }; }) as never;
seams.killScanSession = () => true; seams.hasRoot = () => false; seams.hasSession = () => false; // the scan tmux session is killed, the root row is not touched by that
const f = makeFetch(buildApp());
const call = (path: string, body?: unknown) => f(new Request(`http://x${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), LOOP);

test("scan root (connected, still live) is retired on apply, so the director's join is not refused", async () => {
  await call("/v1/panel/adopt/scan", { dir: ws, mode: "static" });
  const s = (await (await call("/v1/panel/adopt")).json()) as { scanId: string; report: { findings: { id: string; kind: string }[] } };
  setState({ scanner: "director" }); // pretend the scan was the director scan
  const scan = rt.createAgent({ name: "root", by: "t" });
  st.emit({ agent: scan.id, type: "AgentConnected", data: { session: "s", pid: process.pid }, source: "service" }); st.flush();
  expect(st.get(scan.id)?.life).toBe("live");
  const picks = Object.fromEntries(s.report.findings.filter((x) => x.kind !== "scheduled-runner").map((x) => [x.id, "apply"]));
  const plan = (await (await call("/v1/panel/adopt/plan", { scanId: s.scanId, picks: { findings: picks } })).json()) as { planId: string };
  expect((await call("/v1/panel/adopt/apply", { planId: plan.planId })).status).toBe(200);
  expect(directorJoin).toBe(`root#2`);
  expect(st.get(scan.id)?.life).toBe("gone");
});
