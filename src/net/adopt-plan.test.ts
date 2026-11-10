import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFacts, type Facts } from "./adopt-scan";
import { validateReport, type AdoptReport } from "./adopt-report";
import { acceptPicks, buildPlan, computeChanges, opLabel, unifiedDiff } from "./adopt-plan";
import { makeWorkspace } from "../../test/helpers/adoptFixture";

let tmp = "", ws = "", home = "", oldHome: string | undefined, facts: Facts, report: AdoptReport;
const none = { tmux: () => "", crontab: () => "", launchd: () => [] };
const ctx = () => ({ runId: "run-20261110-101500", root: join(tmp, "agentnet"), workspaceDir: join(tmp, "agentnet/workspace") });
const ref = (id: string) => facts.signals.find((s) => s.id === id)!.ref;
function mkReport(): AdoptReport {
  const ev = (id: string, path: string) => [{ signal: ref(id), path }];
  const r = validateReport({
    summary: "x", findings: [
      { id: "f1", kind: "coordination-system", title: "t", about: "a", confidence: "high", risk: "medium", agents: [], evidence: ev("S-HOOK-INJECT", join(ws, ".claude/settings.json")), suggestion: "switch-off", actions: [
        { id: "a1", op: "park-hook", file: join(ws, ".claude/settings.json"), event: "UserPromptSubmit", commandIncludes: "pull-msgs.sh" },
        { id: "a2", op: "park-mcp", file: join(ws, ".mcp.json"), server: "pigeon" }] },
      { id: "f2", kind: "identity-claim", title: "t", about: "a", confidence: "medium", risk: "low", agents: [], evidence: ev("S-INSTR-IDENTITY", join(ws, "CLAUDE.md")), suggestion: "neutralise-lines", actions: [
        { id: "a3", op: "disable-lines", file: join(ws, "CLAUDE.md"), fromLine: 3, toLine: 3, why: "identity" },
        { id: "a4", op: "disable-lines", file: join(ws, "CLAUDE.md"), fromLine: 14, toLine: 15, why: "msg" }] },
      { id: "f3", kind: "agent-definitions", title: "t", about: "a", confidence: "high", risk: "low", agents: ["ios", "kmp"], evidence: ev("S-REPO-AGENT-DEF", join(ws, "ios/.claude/agents/ios.md")), suggestion: "adopt-as-souls", actions: [
        { id: "a5", op: "register-souls", repo: join(ws, "ios"), name: "ios", source: "agent-def", defFile: join(ws, "ios/.claude/agents/ios.md") },
        { id: "a6", op: "register-souls", repo: join(ws, "kmp"), name: "kmp", source: "claude-md" }] },
    ],
  }, facts);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.report;
}
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "adopt-plan-")); ({ ws, home } = makeWorkspace(tmp)); oldHome = process.env.HOME; process.env.HOME = home; facts = collectFacts(ws, none); report = mkReport(); });
afterEach(() => { process.env.HOME = oldHome; rmSync(tmp, { recursive: true, force: true }); });
const all = { findings: { f1: "apply", f2: "apply", f3: "apply" } } as const;
const plan = (p = all as never) => { const r = buildPlan(report, p, ctx()); if (!r.ok) throw new Error(r.errors.join("; ")); return r.plan; };

test("unifiedDiff: small replace with context, and no diff for equal text", () => {
  expect(unifiedDiff("a\nb\nc\n", "a\nb\nc\n")).toBe("");
  expect(unifiedDiff("1\n2\n3\n4\n5\n", "1\n2\nX\n4\n5\n", "a/f", "b/f")).toBe("--- a/f\n+++ b/f\n@@ -1,6 +1,6 @@\n 1\n 2\n-3\n+X\n 4\n 5\n \n");
});

test("fixture CLAUDE.md diff matches the stored expectation", () => {
  const p = plan({ findings: { f2: "apply" } } as never);
  const stub = (a: number, b: number) => `<!-- agentnet: lines ${a}-${b} switched off by run run-20261110-101500; original in backup -->`;
  const ops = p.ops.filter((o) => o.op === "disable-lines");
  expect(ops.length).toBe(2);
  // ops keep the report order; each diff is taken when its edit runs (last line first, so the 14-15 edit is already in)
  expect(ops[0].diff).toContain(`-You are main, coordinator of the harbor team.\n+${stub(3, 3)}`);
  expect(ops[1].diff).toContain(`+${stub(14, 15)}`);
  const final = readFileSync(join(ws, "CLAUDE.md"), "utf8").split("\n");
  expect(final[2]).toContain("coordinator"); // plan never writes
  const c = computeChanges(p.ops as never, p.runId)[0];
  expect(c.afterText.split("\n")[2]).toBe(stub(3, 3));
  expect(c.afterText.split("\n").length).toBe(final.length - 1);
});

test("park-hook and park-mcp change only their key and park the entry", () => {
  const p = plan({ findings: { f1: "apply" } } as never);
  const hook = p.ops.find((o) => o.op === "park-hook")!;
  expect(hook.diff).toContain("-");
  const ch = computeChanges(p.ops as never, p.runId);
  const settings = ch.find((c) => c.file.endsWith("settings.json"))!;
  const after = JSON.parse(settings.afterText);
  expect(after.permissions).toEqual(JSON.parse(settings.beforeText).permissions);
  expect(after.hooks.UserPromptSubmit).toBeUndefined();
  expect(after.hooks.Stop.length).toBe(1);
  expect(settings.steps[0].parked).toMatchObject({ kind: "hook", event: "UserPromptSubmit" });
  const mcp = ch.find((c) => c.file.endsWith(".mcp.json"))!;
  const m = JSON.parse(mcp.afterText);
  expect(Object.keys(m.mcpServers)).toEqual(["lint"]);
  expect(JSON.stringify(mcp.steps[0].parked)).not.toContain("sk-live"); // env values blanked
  expect(JSON.stringify(mcp.steps[0].parked)).toContain("PIGEON_KEY");
});

test("park-hook refuses zero or two matches", () => {
  const f = join(ws, ".claude/settings.json");
  const d = { op: "park-hook" as const, file: f, event: "UserPromptSubmit", matcher: null, commandIncludes: "nope" };
  expect(() => computeChanges([d], "r")).toThrow("0 hooks match");
  const j = JSON.parse(readFileSync(f, "utf8")); j.hooks.UserPromptSubmit[0].hooks.push({ type: "command", command: "x/pull-msgs.sh --again" });
  writeFileSync(f, JSON.stringify(j));
  expect(() => computeChanges([{ ...d, commandIncludes: "pull-msgs.sh" }], "r")).toThrow("2 hooks match");
  expect(() => computeChanges([{ op: "park-mcp", file: join(ws, ".mcp.json"), server: "ghost" }], "r")).toThrow("0 MCP servers");
});

test("planId is stable for equal input and changes with a file or the picks", () => {
  const a = plan(), b = plan();
  expect(a.planId).toBe(b.planId);
  expect(a.planId).toMatch(/^plan-[0-9a-f]{16}$/);
  writeFileSync(join(ws, "CLAUDE.md"), readFileSync(join(ws, "CLAUDE.md"), "utf8") + "\nextra\n");
  expect(plan().planId).not.toBe(a.planId);
  expect(plan({ findings: { f1: "apply" } } as never).planId).not.toBe(a.planId);
});

test("souls: create list, preview, per-action opt-out, no side effects", () => {
  const p = plan({ findings: { f3: "apply" }, actions: { a6: false } } as never);
  const souls = p.ops.filter((o) => o.op === "register-souls");
  expect(souls.map((o) => (o as { name: string }).name)).toEqual(["ios"]);
  expect(souls[0].create).toEqual([join(tmp, "agentnet/workspace/souls/ios.md")]);
  expect(souls[0].preview).toContain("Your repo is");
  expect(p.ops.some((o) => o.op === "write-director-prompt")).toBe(true);
  expect(p.files).toEqual([]);
  expect(() => readFileSync(join(tmp, "agentnet/workspace/souls/ios.md"))).toThrow();
});

test("backup list, backup dir, rollback command, no global", () => {
  const p = plan();
  expect(p.willBackup.sort()).toEqual([join(ws, ".claude/settings.json"), join(ws, ".mcp.json"), join(ws, "CLAUDE.md")].sort());
  expect(p.backupDir).toBe(join(tmp, "agentnet/adopt/run-20261110-101500"));
  expect(p.rollbackCommand).toBe("agentnet adopt rollback run-20261110-101500");
  expect(p.needsConfirmGlobal).toBe(false);
});

test("global file needs confirmation", () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  const g = join(home, ".claude/CLAUDE.md");
  writeFileSync(g, "x\nYou are main agent here.\ny\n");
  facts = collectFacts(ws, none);
  const r = validateReport({ summary: "s", findings: [{ id: "f1", kind: "identity-claim", title: "t", about: "a", confidence: "high", risk: "low", agents: [], suggestion: "neutralise-lines",
    evidence: [{ signal: facts.signals.find((s) => s.file === g && s.id === "S-INSTR-IDENTITY")!.ref, path: g }], actions: [{ id: "a1", op: "disable-lines", file: g, fromLine: 2, toLine: 2, why: "id" }] }] }, facts);
  if (!r.ok) throw new Error(r.errors.join(";"));
  const p = buildPlan(r.report, { findings: { f1: "apply" } }, ctx());
  expect(p.ok && p.plan.needsConfirmGlobal).toBe(true);
  expect(p.ok && p.plan.ops[0].global).toBe(true);
});

test("overlapping line ranges and unknown picks are errors", () => {
  const r = buildPlan(report, { findings: { f9: "apply" } }, ctx());
  expect(r.ok).toBe(false);
  expect(() => computeChanges([{ op: "disable-lines", file: join(ws, "CLAUDE.md"), fromLine: 3, toLine: 5 }, { op: "disable-lines", file: join(ws, "CLAUDE.md"), fromLine: 5, toLine: 6 }], "r")).toThrow("overlap");
});

test("a file the policy denies cannot be in a plan", () => {
  const bad = structuredClone(report);
  (bad.findings[1].actions[0] as { file: string }).file = join(ws, ".env");
  const r = buildPlan(bad, { findings: { f2: "apply" } }, ctx());
  expect(r.ok).toBe(false);
});

test("director prompt path equals director.ts promptPath", async () => {
  const { promptPath } = await import("./director");
  const { directorPromptFile } = await import("./adopt-plan");
  expect(directorPromptFile("/x/y")).toBe(promptPath("adopt", "/x/y"));
});

test("CLI --accept recommended skips high risk and never picks disable-lines (D1); all keeps everything", () => {
  const fs = [
    { id: "f1", risk: "low", actions: [{ id: "a1", op: "park-hook" }] },
    { id: "f2", risk: "low", actions: [{ id: "a2", op: "disable-lines" }, { id: "a3", op: "register-souls" }] },
    { id: "f3", risk: "high", actions: [{ id: "a4", op: "park-mcp" }] },
  ];
  const rec = acceptPicks(fs, "recommended");
  expect(rec.findings).toEqual({ f1: "apply", f2: "apply", f3: "skip" });
  expect(rec.actions).toEqual({ a2: false });
  const all = acceptPicks(fs, "all");
  expect(all.findings).toEqual({ f1: "apply", f2: "apply", f3: "apply" });
  expect(all.actions).toBeUndefined();
});

test("opLabel names the file or the soul, never blank (D7)", () => {
  expect(opLabel({ op: "park-hook", file: "/w/.claude/settings.json" })).toBe("/w/.claude/settings.json");
  expect(opLabel({ op: "register-souls", name: "ios", repo: "/w/ios" })).toBe("ios (/w/ios)");
  expect(opLabel({ op: "park-hook", file: "/h/.claude/settings.json", global: true })).toBe("/h/.claude/settings.json (global)");
});
