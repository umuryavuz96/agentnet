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

// ---------- Park for me: hooks per repo, global MCP, system card, After panel ----------
import { afterPlan, groupFindings as gf, hookRow, midEllipsis, parkGroups, parkedNow, scriptName } from "./adopt";
import type { Finding as F2, Picks as P2 } from "./adopt";
const hookF = (): F2 => ({
  id: "f1", kind: "coordination-system", title: "Inbox hooks", about: "a", confidence: "high", risk: "medium", agents: [], evidence: [], suggestion: "switch-off",
  actions: [
    { id: "a1", op: "park-hook", file: "/w/repoA/.claude/settings.json", event: "Stop", commandIncludes: "$CLAUDE_PROJECT_DIR/bin/check-inbox.sh" },
    { id: "a2", op: "park-hook", file: "/w/repoA/.claude/settings.local.json", event: "Stop", commandIncludes: "poll.sh" },
    { id: "a3", op: "park-hook", file: "/w/repoB/.claude/settings.json", event: "UserPromptSubmit", commandIncludes: "***" },
    { id: "a4", op: "park-mcp", file: "/Users/me/.claude.json", server: "msg-bus" },
  ],
});
const sysF = (): F2 => ({ id: "f2", kind: "coordination-system", title: "The message system", about: "a", confidence: "high", risk: "low", agents: [], evidence: [], suggestion: "keep-as-is", actions: [], parkedBy: ["f1"] });
const rep = () => ({ version: 1 as const, scanId: "s", workspace: "/w", scanner: "director" as const, summary: "x", findings: [hookF(), sysF()] });

test("parkGroups: one group per repo, the user's own files last", () => {
  const g = parkGroups(hookF(), "/w");
  expect(g.map((x) => x.label)).toEqual(["repoA", "repoB", "Your own Claude Code settings"]);
  expect(g[0].actions.length).toBe(2);
  expect(g[2].global).toBe(true);
});
test("hook names are plain and a hidden command gets a readable label", () => {
  expect(scriptName("$CLAUDE_PROJECT_DIR/bin/check-inbox.sh --quiet")).toBe("check-inbox.sh");
  expect(hookRow("Stop", "$CLAUDE_PROJECT_DIR/bin/check-inbox.sh").name).toBe("Stop hook: runs check-inbox.sh");
  const h = hookRow("Stop", "***");
  expect(h.name).toBe("Stop hook");
  expect(h.note).toMatch(/hidden/i);
});
test("midEllipsis keeps the start and the file name", () => {
  expect(midEllipsis("short/file.json")).toBe("short/file.json");
  const m = midEllipsis("~/projects/some/very/deep/folder/.claude/settings.local.json", 36);
  expect(m.length).toBeLessThanOrEqual(38);
  expect(m.startsWith("~/projects/")).toBe(true);
  expect(m.endsWith("settings.local.json") || m.endsWith("…")).toBe(true);
});
test("system card: not a manual card, parked once the finding that parks it is applied", () => {
  const r = rep(), g = gf(r.findings);
  expect(g.system.map((f) => f.id)).toEqual(["f2"]);
  expect(g.manual).toEqual([]);
  const on: P2 = { findings: { f1: "apply" }, skipActions: [] }, off: P2 = { findings: { f1: "skip" }, skipActions: [] };
  expect(parkedNow(r.findings[1], r.findings, on)).toBe(true);
  expect(parkedNow(r.findings[1], r.findings, off)).toBe(false);
  expect(parkedNow(r.findings[1], r.findings, { findings: { f1: "apply" }, skipActions: ["a1", "a2", "a3", "a4"] })).toBe(false);
});
test("After panel follows the picks: a repo left on moves to Keeps running", () => {
  const all = afterPlan(rep(), { findings: { f1: "apply" }, skipActions: [] }, "/w");
  expect(all.offCount).toBe(4); // 4 actions; the system card is a status line
  expect(all.stayCount).toBe(0);
  expect(all.off.map((g) => g.label)).toEqual(["Old message system", "repoA", "repoB", "Your own Claude Code settings"].sort((a, b) => (a === "Your own Claude Code settings" ? 1 : b === "Your own Claude Code settings" ? -1 : a.localeCompare(b))));
  const part = afterPlan(rep(), { findings: { f1: "apply" }, skipActions: ["a1", "a2"] }, "/w");
  expect(part.offCount).toBe(2);
  expect(part.stay.find((g) => g.label === "repoA")?.rows.length).toBe(2);
  expect(part.messaging).toMatch(/still runs next to it/);
  expect(part.stay.find((g) => g.key === "system")?.rows[0].note).toMatch(/beside agentnet/); // repoA left on: the old system keeps running
  const none = afterPlan(rep(), { findings: { f1: "skip" }, skipActions: [] }, "/w");
  expect(none.offCount).toBe(0);
  expect(none.stay.find((g) => g.key === "system")?.rows[0].note).toMatch(/beside agentnet/);
});
