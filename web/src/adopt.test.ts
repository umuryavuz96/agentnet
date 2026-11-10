import { describe, expect, test } from "bun:test";
import { changedOps, defaultPicks, diffStat, groupFindings, hasPicks, parseDiff, pickedFiles, planSummary, sortFindings, type AdoptPlan, type Finding } from "./adopt";

const f = (o: Partial<Finding> & { id: string }): Finding => ({ kind: "other", title: "t", about: "a", confidence: "high", risk: "low", agents: [], evidence: [], suggestion: "keep-as-is", actions: [], ...o });

describe("adopt helpers", () => {
  test("card order: coordination first, then identity, hooks, lines, agent defs", () => {
    const s = sortFindings([f({ id: "f4", kind: "agent-definitions" }), f({ id: "f2", kind: "identity-claim" }), f({ id: "f10", kind: "coordination-system" }), f({ id: "f3", kind: "workspace-instructions" })]);
    expect(s.map((x) => x.kind)).toEqual(["coordination-system", "identity-claim", "workspace-instructions", "agent-definitions"]);
  });
  test("groups: manual and keep-as-is leave the main list", () => {
    const g = groupFindings([f({ id: "f1", suggestion: "switch-off" }), f({ id: "f2", suggestion: "manual" }), f({ id: "f3" })]);
    expect([g.cards.length, g.manual.length, g.fine.length]).toEqual([1, 1, 1]);
  });
  test("default picks follow section 4.2", () => {
    const p = defaultPicks([
      f({ id: "f1", suggestion: "switch-off", confidence: "high" }), f({ id: "f2", suggestion: "switch-off", confidence: "medium" }),
      f({ id: "f3", suggestion: "adopt-as-souls", confidence: "medium" }), f({ id: "f4", suggestion: "neutralise-lines", confidence: "high" }),
      f({ id: "f5", suggestion: "adopt-as-souls", confidence: "low" }), f({ id: "f6", suggestion: "manual" }),
    ]);
    expect(p.findings).toEqual({ f1: "apply", f2: "skip", f3: "apply", f4: "skip", f5: "skip" });
  });
  test("picked files are unique and only for applied cards", () => {
    const fs = [
      f({ id: "f1", suggestion: "switch-off", actions: [{ id: "a1", op: "park-hook", file: "/w/s.json", event: "Stop", commandIncludes: "x" }, { id: "a2", op: "park-mcp", file: "/w/s.json", server: "p" }] }),
      f({ id: "f2", suggestion: "neutralise-lines", actions: [{ id: "a3", op: "disable-lines", file: "/w/CLAUDE.md", fromLine: 3, toLine: 5, why: "w" }] }),
    ];
    const picks = { findings: { f1: "apply" as const, f2: "skip" as const }, skipActions: [] };
    expect(pickedFiles(fs, picks)).toEqual(["/w/s.json"]);
    expect(hasPicks(fs, picks)).toBe(true);
    expect(hasPicks(fs, { findings: { f1: "skip", f2: "skip" }, skipActions: [] })).toBe(false);
  });
  test("diff parse and stat", () => {
    const d = "--- a/x\n+++ b/x\n@@ -1,2 +1,1 @@\n-old\n+new\n keep\n";
    expect(parseDiff(d).map((l) => l.t)).toEqual(["meta", "meta", "hunk", "del", "add", "ctx"]);
    expect(diffStat(d)).toEqual({ add: 1, del: 1 });
    expect(parseDiff(undefined)).toEqual([]);
  });
  test("changed rows exclude created files such as the director prompt (D3)", () => {
    const p: AdoptPlan = { planId: "plan-1", workspace: "/w", ops: [{ op: "park-hook", file: "/w/a" }, { op: "write-director-prompt", file: "/h/run/souls/agentnet-director.md", create: ["/h/run/souls/agentnet-director.md"] }], willBackup: [], backupDir: "/b", rollbackCommand: "r", warnings: [] };
    expect(changedOps(p).map((o) => o.op)).toEqual(["park-hook"]);
  });
  test("plan summary counts", () => {
    const p: AdoptPlan = { planId: "plan-1", workspace: "/w", ops: [{ op: "park-hook", file: "/w/a" }, { op: "register-souls", create: ["a", "b"] }], willBackup: ["/w/a"], backupDir: "/b", rollbackCommand: "r", warnings: [] };
    expect(planSummary(p)).toBe("1 file changes, 2 files are created, 1 file is backed up first.");
  });
});
