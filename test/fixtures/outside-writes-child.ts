// Child of test/no-outside-writes.test.ts. It runs with a temp HOME and a scratch AGENTNET_HOME (both set by the parent, before
// the config is loaded) and does every write path the one-folder rule covers through the API: Hooks page save, switch off, switch on,
// and an adopt scan -> plan -> apply whose picks target the user's files. It prints one JSON line with what it saw.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ws = process.argv[2]!;
const { ROOT } = await import("../../src/core/config");
const { buildApp, makeFetch } = await import("../../src/server");
{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../../src/core/db"); useDatabase(new Database(":memory:")); }
const { seams, setState } = await import("../../src/net/adopt");
seams.startDirector = (() => ({ ok: true, session: "x", attach: "tmux a" })) as never;
seams.killScanSession = () => false; seams.hasRoot = () => false; seams.hasSession = () => false;
setState({ phase: "idle" });

const f = makeFetch(buildApp());
const tok = readFileSync(join(ROOT, "run", "root.token"), "utf8").trim();
const LOOP = { requestIP: () => ({ address: "127.0.0.1" }) };
const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
  const r = await f(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: body === undefined ? undefined : JSON.stringify(body) }), LOOP);
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};

const out: Record<string, unknown> = {};
const list0 = await call("/api/v1/agent-hooks");
out.external = list0.json.external;
const save = await call("/api/v1/agent-hooks/install-set", {});
out.saveStatus = save.status; out.added = save.json.added?.length ?? 0;
const id = (save.json.hooks as { id: string; enabled: boolean }[]).find((h) => h.enabled)!.id;
out.offStatus = (await call(`/api/v1/agent-hooks/${id}/enabled`, { enabled: false })).status;
out.onStatus = (await call(`/api/v1/agent-hooks/${id}/enabled`, { enabled: true })).status;

out.scanStatus = (await call("/v1/panel/adopt/scan", { dir: ws, mode: "static" })).status;
const st = (await call("/v1/panel/adopt")).json as { scanId: string; report: { findings: { id: string; kind: string }[] } };
const picks = Object.fromEntries(st.report.findings.filter((x) => x.kind !== "scheduled-runner").map((x) => [x.id, "apply"]));
const plan = await call("/v1/panel/adopt/plan", { scanId: st.scanId, picks: { findings: picks } });
out.planStatus = plan.status; out.ops = (plan.json.ops as { op: string }[]).map((o) => o.op); out.manual = (plan.json.manual ?? []).length;
out.applyStatus = (await call("/v1/panel/adopt/apply", { planId: plan.json.planId })).status;
out.root = ROOT;
console.log(JSON.stringify(out));
