// Setup scan session: apply from its chat, re-report, line edits found again at apply time, predecessor leftovers on by default.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWorkspace } from "../../test/helpers/adoptFixture";

const tmp = mkdtempSync(join(tmpdir(), "an-adopt-chat-"));
const { ws, home } = makeWorkspace(tmp);
// the predecessor's leftovers: an MCP server and lines in CLAUDE.md
const mcpFile = join(ws, ".mcp.json"), mdFile = join(ws, "CLAUDE.md");
const mcp = JSON.parse(readFileSync(mcpFile, "utf8")); mcp.mcpServers.agmsg = { command: "agmsg-mcp" }; writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + "\n");
const sj = join(ws, ".claude", "settings.json"), sset = JSON.parse(readFileSync(sj, "utf8")); sset.permissions.allow.push("mcp__agmsg__send_message"); writeFileSync(sj, JSON.stringify(sset, null, 2) + "\n");
appendFileSync(mdFile, "Send a message to a teammate with agmsg, and check your inbox with it.\n");
const ENV = ["AGENTNET_HOME", "AGENTNET_WORKSPACE_DIR", "HOME", "AGENTNET_ADOPT_STUB", "TMUX"];
const old: Record<string, string | undefined> = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
process.env.AGENTNET_HOME = join(tmp, "agentnet"); process.env.AGENTNET_WORKSPACE_DIR = join(tmp, "agentnet", "workspace"); process.env.HOME = home; delete process.env.TMUX;
mkdirSync(process.env.AGENTNET_HOME, { recursive: true });
{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../core/db"); useDatabase(new Database(":memory:")); (await import("./store"))._reset(); }
const { ROOT } = await import("../core/config");
const A = await import("./adopt");
const { defaultPicksFor, relocateLines } = await import("./adopt-plan");
const { lineHash } = await import("./adopt-report");
const rt = await import("./routes");
const saved = { ...A.seams };
const started: unknown[] = [];
let killed = 0;
A.seams.startDirector = ((dir: string, _r: unknown, _t: unknown, _e: unknown, opts: unknown) => { started.push({ dir, opts }); return { ok: true, session: "x", attach: "" }; }) as never;
A.seams.killScanSession = () => { killed++; return true; }; A.seams.hasRoot = () => false; A.seams.hasSession = () => false; A.seams.hasScan = () => false;
A.seams.later = (fn) => fn(); // the session closes a moment after the answer: here at once
afterAll(async () => { await Bun.sleep(1100); Object.assign(A.seams, saved); A.setState({ phase: "idle", scanner: null, mode: null, workspace: null, scanId: null, planId: null, runId: null, error: null }); for (const k of ENV) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } });

const factsOf = () => JSON.parse(readFileSync(join(ROOT, "adopt", "current", "facts.json"), "utf8"));
const reportOf = () => (A.view().report as unknown as { findings: { id: string; suggestion: string; confidence: string; actions: Record<string, unknown>[] }[] });

test("predecessor leftovers are tagged and on by default; the rest of their finding stays off", () => {
  expect(A.startScan(ws, "static").ok).toBe(true);
  const fs = reportOf().findings, tagged = fs.flatMap((f) => f.actions.filter((a) => a.legacy === true));
  expect(tagged.some((a) => a.op === "park-mcp" && a.server === "agmsg")).toBe(true);
  expect(tagged.some((a) => a.op === "disable-lines")).toBe(true);
  expect(fs.flatMap((f) => f.actions).filter((a) => a.op === "park-mcp" && a.server !== "agmsg").every((a) => !a.legacy)).toBe(true);
  const rep = A.loadStateReport();
  const p = defaultPicksFor(rep);
  for (const f of rep.findings) if (f.actions.some((a) => "legacy" in a && a.legacy)) expect(p.findings[f.id]).toBe("apply");
  const off = Object.entries(p.actions ?? {}).filter(([, v]) => v === false).map(([id]) => id);
  for (const f of rep.findings) for (const a of f.actions) if (a.op !== "manual" && !("legacy" in a && a.legacy) && p.findings[f.id] === "apply" && f.suggestion !== "adopt-as-souls" && f.confidence !== "high") expect(off).toContain(a.id);
});

test("a newer report replaces the old one while reported or planned; the plan is reset", () => {
  const st0 = A.loadState(); expect(st0.phase).toBe("reported");
  const rep = A.loadStateReport();
  const plan = A.makePlan(st0.scanId, defaultPicksFor(rep)); expect(plan.ok).toBe(true);
  expect(A.loadState().phase).toBe("planned");
  const r = A.submitReport(A.staticReport(factsOf()), "director");
  expect(r.ok).toBe(true);
  const st = A.loadState(); expect(st.phase).toBe("reported"); expect(st.planId).toBeNull();
});

test("apply from the chat needs the owner's yes, uses default picks without a plan, and keeps backups + Rollback", async () => {
  const bad = await A.applyFromChat(undefined, false); expect(bad.ok).toBe(false);
  const before = readFileSync(mdFile, "utf8");
  const scan = rt.createAgent({ name: "setup-scan", by: "t" });
  A.setState({ scanner: "director" });
  const r = await A.applyFromChat(true, true);
  expect(r.ok).toBe(true);
  expect(A.loadState().phase).toBe("applied");
  expect(readFileSync(mdFile, "utf8")).not.toBe(before);
  expect(readFileSync(mdFile, "utf8")).toContain("switched off by run");
  expect(JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers.agmsg).toBeUndefined();
  expect(started.length).toBe(1); expect(killed).toBeGreaterThan(0);
  expect(rt.byName("setup-scan")).toBeFalsy(); // retired
  expect(scan.id).toBeTruthy();
  expect((await A.applyFromChat(true, true)).ok).toBe(false); // phase is applied now
  expect(A.doRollback(undefined, false).ok).toBe(true);
  expect(readFileSync(mdFile, "utf8")).toBe(before);
});

test("relocateLines: same place, moved, gone", () => {
  const f = join(tmp, "x.md"); writeFileSync(f, "a\nb\nc\nd\n");
  const exp = ["b", "c"].map(lineHash);
  expect(relocateLines(f, 2, 3, exp)).toEqual({ fromLine: 2, toLine: 3 });
  writeFileSync(f, "new\nnew2\na\nb\nc\nd\n");
  expect(relocateLines(f, 2, 3, exp)).toEqual({ fromLine: 4, toLine: 5 });
  writeFileSync(f, "a\nd\n");
  expect(relocateLines(f, 2, 3, exp)).toBeNull();
  expect(relocateLines(f, 2, 3, undefined)).toEqual({ fromLine: 2, toLine: 3 });
});

test("apply re-checks line edits: moved text is found again, gone text is skipped and listed", async () => {
  await Bun.sleep(1100);
  const base = readFileSync(mdFile, "utf8");
  expect(A.startScan(ws, "static").ok).toBe(true);
  const rep = A.loadStateReport();
  const lineActs = rep.findings.flatMap((f) => f.actions.filter((a) => a.op === "disable-lines"));
  expect(lineActs.length).toBeGreaterThan(1);
  const picks: Record<string, "apply"> = Object.fromEntries(rep.findings.filter((f) => f.actions.some((a) => a.op === "disable-lines")).map((f) => [f.id, "apply"]));
  const plan = A.makePlan(A.loadState().scanId, { findings: picks }); expect(plan.ok).toBe(true);
  // the file changes after the preview: two lines pushed to the top, and the last flagged line deleted
  const gone = (lineActs[lineActs.length - 1] as { fromLine: number }).fromLine;
  const ls = base.split("\n"); ls.splice(gone - 1, 1);
  writeFileSync(mdFile, "# moved\nnew line\n" + ls.join("\n"));
  const r = await A.applyCurrent(A.loadState().planId, true);
  expect(r.ok).toBe(true);
  if (r.ok) { expect(r.skipped.length).toBe(1); expect(r.skipped[0]).toContain("CLAUDE.md"); }
  expect(A.loadState().skipped.length).toBe(1);
  const after = readFileSync(mdFile, "utf8");
  expect(after.startsWith("# moved\nnew line\n")).toBe(true);
  expect(after).toContain("switched off by run");
  A.doRollback(undefined, false);
});
