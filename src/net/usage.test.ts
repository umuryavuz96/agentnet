import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-usage-"));
const d = mkdtempSync(join(tmpdir(), "sd-usage-data-")); process.env.USAGE_DATA_DIR = d;
const { Database } = await import("bun:sqlite");
const { useDatabase } = await import("../core/db");
const st = await import("./store");
const { usageByAgent } = await import("./usage");

const NOW = 1_800_000_000_000, H = 3600_000;
const spawn = (id: string) => st.emit({ agent: id, type: "AgentSpawned", data: { id, name: id.split("#")[0], gen: 1, model: "claude-sonnet-5-5" }, source: "spawn", ts: NOW - 200 * H });
const turn = (id: string, ago: number, out: number, model = "claude-sonnet-5-5") => st.emit({ agent: id, type: "TurnEnded", data: { usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, model } }, source: "mod", ts: NOW - ago * H });
beforeEach(() => { useDatabase(new Database(":memory:")); st._reset(); });

test("sums tokens per agent over the 5 h and weekly windows; missing 5 h limit is reported, not invented", () => {
  writeFileSync(join(d, "claude-usage.json"), JSON.stringify({ last: { session: null, week: { pct: 20, resetsAt: (NOW + 24 * H) / 1000 } } }));
  spawn("a#1"); spawn("b#1");
  turn("a#1", 1, 100); turn("a#1", 10, 50); turn("a#1", 300, 999) /* before the week */; turn("b#1", 2, 25, "claude-opus-5-5");
  st.emit({ agent: "a#1", type: "AgentConnected", data: {}, source: "mod", ts: NOW - 100 * H }); st.emit({ agent: "a#1", type: "ContextMeasured", data: { tokens: 5, window: 100, pct: 5 }, source: "mod", ts: NOW - 50 * H });
  st.flush();
  const u = usageByAgent(NOW), a = u.agents.find((x) => x.agent === "a")!, b = u.agents.find((x) => x.agent === "b")!;
  expect(a.fiveHour).toEqual({ input: 10, output: 100, cacheRead: 1000, cacheWrite: 5, turns: 1 });
  expect(a.weekly.output).toBe(150); expect(a.weekly.turns).toBe(2);
  expect(b.byModel["claude-opus-5-5"].output).toBe(25);
  expect(a.context?.pct).toBe(5);
  expect(u.windows.weekly.accountPct).toBe(20); expect(u.windows.fiveHour.accountPct).toBeNull();
  expect(a.weeklyShare! + b.weeklyShare!).toBeCloseTo(100, 0);
  expect(u.agents[0].agent).toBe("a");
});

test("no claude-usage.json: windows say null and the reason is in sources", () => {
  process.env.USAGE_DATA_DIR = mkdtempSync(join(tmpdir(), "sd-usage-none-"));
  const u = usageByAgent(NOW);
  expect(u.windows.weekly.accountPct).toBeNull(); expect(u.sources.accountPct).toContain("missing");
  process.env.USAGE_DATA_DIR = d;
});
