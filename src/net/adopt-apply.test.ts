import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFacts, type Facts } from "./adopt-scan";
import { validateReport, type AdoptReport } from "./adopt-report";
import { buildPlan, type Plan } from "./adopt-plan";
import { applyPlan, listRuns, rollbackRun, KEEP_RUNS } from "./adopt-apply";
import { makeWorkspace } from "../../test/helpers/adoptFixture";

let tmp = "", ws = "", home = "", root = "", wsd = "", oldHome: string | undefined, facts: Facts, report: AdoptReport;
const none = { tmux: () => "", crontab: () => "", launchd: () => [] };
const ref = (id: string) => facts.signals.find((s) => s.id === id)!.ref;
function mkReport(): AdoptReport {
  const ev = (id: string, path: string) => [{ signal: ref(id), path }];
  const r = validateReport({ summary: "x", findings: [
    { id: "f1", kind: "coordination-system", title: "t", about: "a", confidence: "high", risk: "medium", agents: [], evidence: ev("S-HOOK-INJECT", join(ws, ".claude/settings.json")), suggestion: "switch-off", actions: [
      { id: "a1", op: "park-hook", file: join(ws, ".claude/settings.json"), event: "UserPromptSubmit", commandIncludes: "pull-msgs.sh" },
      { id: "a2", op: "park-mcp", file: join(ws, ".mcp.json"), server: "pigeon" }] },
    { id: "f2", kind: "identity-claim", title: "t", about: "a", confidence: "medium", risk: "low", agents: [], evidence: ev("S-INSTR-IDENTITY", join(ws, "CLAUDE.md")), suggestion: "neutralise-lines", actions: [
      { id: "a3", op: "disable-lines", file: join(ws, "CLAUDE.md"), fromLine: 3, toLine: 3, why: "identity" }] },
    { id: "f3", kind: "agent-definitions", title: "t", about: "a", confidence: "high", risk: "low", agents: ["ios"], evidence: ev("S-REPO-AGENT-DEF", join(ws, "ios/.claude/agents/ios.md")), suggestion: "adopt-as-souls", actions: [
      { id: "a5", op: "register-souls", repo: join(ws, "ios"), name: "ios", source: "agent-def", defFile: join(ws, "ios/.claude/agents/ios.md") }] },
  ] }, facts);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.report;
}
const plan = (runId = "run-20261110-101500", picks: Record<string, "apply" | "skip"> = { f1: "apply", f2: "apply", f3: "apply" }): Plan => {
  const r = buildPlan(report, { findings: picks }, { runId, root, workspaceDir: wsd });
  if (!r.ok) throw new Error(r.errors.join("; ")); return r.plan;
};
const snap = (dir: string, out = new Map<string, string>()): Map<string, string> => {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) snap(p, out); else out.set(p, readFileSync(p, "utf8")); }
  return out;
};
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "adopt-apply-")); ({ ws, home } = makeWorkspace(tmp)); oldHome = process.env.HOME; process.env.HOME = home;
  root = join(tmp, "agentnet"); wsd = join(root, "workspace");
  facts = collectFacts(ws, none); report = mkReport();
});
afterEach(() => { process.env.HOME = oldHome; rmSync(tmp, { recursive: true, force: true }); });
const mode = (p: string) => statSync(p).mode & 0o777;

test("happy path: backup verified, files changed, souls and prompt written, manifest correct", async () => {
  const before = snap(ws);
  const p = plan();
  const r = await applyPlan(p, { root, workspaceDir: wsd });
  expect(r.ok).toBe(true); if (!r.ok) return;
  const m = r.manifest;
  expect(m.state).toBe("applied");
  expect(mode(r.runDir)).toBe(0o700);
  for (const f of m.files.filter((x) => x.beforeSha)) {
    expect(mode(f.backup!)).toBe(0o600);
    expect(readFileSync(f.backup!, "utf8")).toBe(before.get(f.file) ?? "");
  }
  expect(readFileSync(join(ws, "CLAUDE.md"), "utf8")).toContain("switched off by run run-20261110-101500");
  expect(JSON.parse(readFileSync(join(ws, ".mcp.json"), "utf8")).mcpServers.pigeon).toBeUndefined();
  expect(existsSync(join(wsd, "souls/ios.md"))).toBe(true);
  expect(readFileSync(join(root, "run/souls/agentnet-director.md"), "utf8")).toContain("Workspace precedence");
  expect(m.created.some((c) => c.endsWith("souls/ios.md"))).toBe(true);
  expect(m.parked.map((x) => x.kind).sort()).toEqual(["hook", "mcp"]);
  expect(JSON.stringify(m)).not.toContain("sk-live"); // manifest has shas and blanked entries only
  expect(JSON.stringify(m)).not.toContain("abc123");
  expect(mode(join(r.runDir, "manifest.json"))).toBe(0o600);
  expect(listRuns(root)[0]).toMatchObject({ runId: "run-20261110-101500", state: "applied" });
});

test("failure on the 2nd write rolls back: originals byte-identical, no souls", async () => {
  const before = snap(ws);
  let n = 0;
  const r = await applyPlan(plan(), { root, workspaceDir: wsd, fsOps: { write: (path, text, mode) => { if (++n === 2) throw new Error("disk full"); require("./adopt-safe").writeAtomic(path, text, mode); } } });
  expect(r.ok).toBe(false); if (r.ok) return;
  expect(r.rolledBack).toBe(true); expect(r.error).toContain("disk full");
  expect(snap(ws)).toEqual(before);
  expect(existsSync(join(wsd, "souls"))).toBe(false);
  expect(existsSync(join(root, "run/souls/agentnet-director.md"))).toBe(false);
  expect(listRuns(root)[0].state).toBe("failed");
});

test("stale plan: a file edited between plan and apply is a 409 and nothing changes", async () => {
  const p = plan();
  writeFileSync(join(ws, "CLAUDE.md"), readFileSync(join(ws, "CLAUDE.md"), "utf8") + "more\n");
  const before = snap(ws);
  const r = await applyPlan(p, { root, workspaceDir: wsd });
  expect(r).toMatchObject({ ok: false, status: 409 });
  if (!r.ok) expect(r.error).toContain("changed since the preview");
  expect(snap(ws)).toEqual(before);
  expect(existsSync(join(root, "adopt"))).toBe(false);
});

test("edited plan object is refused", async () => {
  const p = plan();
  p.ops = p.ops.slice(1);
  expect(await applyPlan(p, { root, workspaceDir: wsd })).toMatchObject({ ok: false, status: 409 });
});

test("rollback restores bytes, removes souls and the new prompt", async () => {
  const before = snap(ws);
  const r = await applyPlan(plan(), { root, workspaceDir: wsd }); expect(r.ok).toBe(true);
  const rb = rollbackRun(undefined, { root, workspaceDir: wsd });
  expect(rb.ok).toBe(true); expect(rb.kept).toEqual([]);
  expect(rb.restored.length).toBe(3);
  expect(snap(ws)).toEqual(before);
  expect(existsSync(join(wsd, "souls/ios.md"))).toBe(false);
  expect(existsSync(join(root, "run/souls/agentnet-director.md"))).toBe(false);
  expect(rb.notes.join(" ")).toContain("restart the director");
  expect(listRuns(root)[0].state).toBe("rolledback");
  // twice = no-op
  expect(rollbackRun(undefined, { root, workspaceDir: wsd })).toMatchObject({ ok: true, nothingToDo: true });
  expect(rollbackRun("run-20261110-101500", { root, workspaceDir: wsd })).toMatchObject({ nothingToDo: true });
});

test("rollback never overwrites a file edited after apply unless forced", async () => {
  await applyPlan(plan(), { root, workspaceDir: wsd });
  const mine = readFileSync(join(ws, "CLAUDE.md"), "utf8") + "\nmy own edit\n";
  writeFileSync(join(ws, "CLAUDE.md"), mine);
  const rb = rollbackRun(undefined, { root, workspaceDir: wsd });
  expect(rb.kept.map((k) => k.file)).toEqual([join(ws, "CLAUDE.md")]);
  expect(rb.notes.join(" ")).toContain("kept your newer version");
  expect(readFileSync(join(ws, "CLAUDE.md"), "utf8")).toBe(mine);
  expect(existsSync(rb.kept[0].backup!)).toBe(true);
  const forced = rollbackRun(undefined, { root, workspaceDir: wsd, force: true });
  expect(forced.restored).toEqual([join(ws, "CLAUDE.md")]);
  expect(readFileSync(join(ws, "CLAUDE.md"), "utf8")).toContain("You are main, coordinator");
});

test("an existing director prompt is backed up and restored", async () => {
  const pf = join(root, "run/souls/agentnet-director.md");
  require("node:fs").mkdirSync(join(root, "run/souls"), { recursive: true }); writeFileSync(pf, "old prompt\n");
  const p = plan(); expect(p.willBackup).toContain(pf);
  await applyPlan(p, { root, workspaceDir: wsd });
  expect(readFileSync(pf, "utf8")).not.toBe("old prompt\n");
  rollbackRun(undefined, { root, workspaceDir: wsd });
  expect(readFileSync(pf, "utf8")).toBe("old prompt\n");
});

test("a global plan needs confirmGlobal", async () => {
  require("node:fs").mkdirSync(join(home, ".claude"), { recursive: true });
  const g = join(home, ".claude/CLAUDE.md"); writeFileSync(g, "x\nYou are main agent here.\ny\n");
  facts = collectFacts(ws, none);
  const rep = validateReport({ summary: "s", findings: [{ id: "f1", kind: "identity-claim", title: "t", about: "a", confidence: "high", risk: "low", agents: [], suggestion: "neutralise-lines",
    evidence: [{ signal: facts.signals.find((s) => s.file === g && s.id === "S-INSTR-IDENTITY")!.ref, path: g }], actions: [{ id: "a1", op: "disable-lines", file: g, fromLine: 2, toLine: 2, why: "id" }] }] }, facts);
  if (!rep.ok) throw new Error(rep.errors.join(";"));
  const b = buildPlan(rep.report, { findings: { f1: "apply" } }, { runId: "run-g", root, workspaceDir: wsd }); if (!b.ok) throw new Error("plan");
  expect(await applyPlan(b.plan, { root, workspaceDir: wsd })).toMatchObject({ ok: false, status: 400 });
  expect((await applyPlan(b.plan, { root, workspaceDir: wsd, confirmGlobal: true })).ok).toBe(true);
});

test("the 6th run prunes the oldest only", async () => {
  let t = Date.UTC(2026, 10, 10);
  for (let i = 1; i <= KEEP_RUNS + 1; i++) {
    const r = await applyPlan(plan(`run-2026111${i}-000000`, { f3: "apply" }), { root, workspaceDir: wsd, now: () => (t += 60_000) });
    expect(r.ok).toBe(true);
  }
  const ids = listRuns(root).map((r) => r.runId);
  expect(ids.length).toBe(KEEP_RUNS);
  expect(ids).not.toContain("run-20261111-000000");
  expect(ids[0]).toBe("run-20261116-000000");
});
