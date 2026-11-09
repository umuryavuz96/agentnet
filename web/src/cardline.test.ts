import { describe, expect, test } from "bun:test";
import { cardLine, toolPhrase, ago } from "./cardline";
import type { AgentRow, Check } from "./net";

const NOW = 1_000_000_000;
const row = (o: Partial<AgentRow> = {}): AgentRow => ({
  id: "a#1", name: "a", job: null, boss: "root", model: null, effort: null, life: "live", lifeSince: NOW - 600_000, state: "working", stateSince: NOW - 300_000,
  action: null, reported: null, tasks: [], context: null, cost: null, lastMsg: null, doing: null, seq: 1, lastTool: null, ...o,
} as AgentRow);
const tool = (tool: string, target: string | null, age: number) => ({ tool, target, ok: true, ms: 5, at: NOW - age });
const task = (text: string) => [{ id: 1, text, status: "in_progress" as const }];

describe("toolPhrase", () => {
  test("plain words", () => {
    expect(toolPhrase("Edit", "/x/web/src/components/AgentnetMap.vue")).toBe("Editing AgentnetMap.vue");
    expect(toolPhrase("Bash", "bun test --bail")).toBe("Running tests");
    expect(toolPhrase("Bash", "bunx vue-tsc --noEmit")).toBe("Type-checking");
    expect(toolPhrase("Bash", "git commit -m x")).toBe("Committing");
    expect(toolPhrase("Bash", "FOO=1 make all")).toBe("Running make");
    expect(toolPhrase("Grep", "foo")).toBe("Searching the code");
    expect(toolPhrase("mcp__agentnet__set_status", null)).toBeNull();
    expect(toolPhrase("mcp__agentnet__task_done", null)).toBe("Updating its tasks");
    expect(toolPhrase("mcp__claude-in-chrome__navigate", null)).toBe("Chrome: navigate");
  });
  test("ago", () => { expect(ago(7_000)).toBe("7s"); expect(ago(180_000)).toBe("3m"); expect(ago(2 * 3600_000)).toBe("2h"); });
});

describe("cardLine", () => {
  test("fresh tool call beats the in-progress task", () => {
    expect(cardLine(row({ tasks: task("Build the thing"), lastTool: tool("Bash", "bun test", 3_000) }), NOW)).toBe("Running tests");
  });
  test("a running call counts, even with no finished one", () => {
    expect(cardLine(row({ tasks: task("Build"), action: { tool: "Edit", target: "a/b.ts", at: NOW - 1_000 } }), NOW)).toBe("Editing b.ts");
  });
  test("tool older than 20 s: the task text shows", () => {
    expect(cardLine(row({ tasks: task("Build the thing"), lastTool: tool("Bash", "bun test", 25_000) }), NOW)).toBe("Build the thing");
  });
  test("report dropped once newer tool work outruns it by 2 min", () => {
    const reported = { doing: "Measuring", progress: null, phase: null, blockedOn: null, at: NOW - 200_000, turn: 1 };
    expect(cardLine(row({ reported, lastTool: tool("Bash", "ls", 40_000) }), NOW)).toBe("Looking at files");
  });
  test("report shows while it is not outrun", () => {
    const reported = { doing: "Measuring", progress: null, phase: null, blockedOn: null, at: NOW - 100_000, turn: 1 };
    expect(cardLine(row({ reported, lastTool: tool("Bash", "ls", 40_000) }), NOW)).toBe("Measuring");
  });
  test("blocked and owner check win", () => {
    const reported = { doing: "x", progress: null, phase: null, blockedOn: "a decision", at: NOW, turn: 1 };
    expect(cardLine(row({ reported, lastTool: tool("Bash", "ls", 1_000) }), NOW)).toBe("Blocked: a decision");
    const k = { state: "pending", agent: "a", question: "Do you see it?" } as Check;
    expect(cardLine(row({ lastTool: tool("Bash", "ls", 1_000) }), NOW, [k])).toBe("Waiting for the owner: Do you see it?");
  });
  test("idle over 60 s: last thing and its age", () => {
    expect(cardLine(row({ state: "idle", stateSince: NOW - 120_000, lastTool: tool("Edit", "x/y.vue", 180_000) }), NOW)).toBe("Idle · last: Editing y.vue 3m ago");
    expect(cardLine(row({ state: "idle", stateSince: NOW - 30_000, lastTool: tool("Edit", "x/y.vue", 31_000) }), NOW)).toBe("Editing y.vue"); // idle under 60 s: plain last tool
  });
  test("waiting for a reply", () => {
    expect(cardLine(row({ state: "idle", stateSince: NOW - 10_000, lastTool: tool("Bash", "ls", 20_000), lastMsg: { dir: "out", peer: "root", kind: "question", snippet: "?", at: NOW - 10_000 } }), NOW)).toBe("Waiting for root to reply");
  });
  test("nothing known: null", () => { expect(cardLine(row(), NOW)).toBeNull(); });
});
