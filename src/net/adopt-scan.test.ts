import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFacts, lexHits, LIMITS } from "./adopt-scan";
import { makeWorkspace } from "../../test/helpers/adoptFixture";

let tmp = "", ws = "", home = "", oldHome: string | undefined;
const none = { tmux: () => "", crontab: () => "", launchd: () => [] };
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "adopt-scan-")); ({ ws, home } = makeWorkspace(tmp)); oldHome = process.env.HOME; process.env.HOME = home; });
afterEach(() => { process.env.HOME = oldHome; rmSync(tmp, { recursive: true, force: true }); });

test("lexicon matches whole words only", () => {
  expect(lexHits("pull-msgs.sh")).toEqual([]);
  expect(lexHits("cat ~/.bus/inbox/$AGENT")).toEqual(["inbox"]);
  expect(lexHits("Report to the team")).toEqual(expect.arrayContaining(["team", "report to"]));
  expect(lexHits("lint-mcp")).toEqual([]);
});

test("fixture signals", () => {
  const f = collectFacts(ws, none);
  const by = (id: string) => f.signals.filter((s) => s.id === id);
  const hook = by("S-HOOK-INJECT");
  expect(hook.length).toBe(1);
  expect(hook[0]).toMatchObject({ event: "UserPromptSubmit", scriptPath: join(ws, "bin/pull-msgs.sh") });
  expect((hook[0].hits as { line: number }[])[0].line).toBe(2);
  expect(by("S-MCP").map((s) => s.server)).toEqual(["pigeon"]);
  expect(JSON.stringify(by("S-MCP"))).not.toContain("sk-live");
  const msg = by("S-INSTR-MSG");
  expect(msg.length).toBe(2);
  expect(msg[0]).toMatchObject({ fromLine: 14, toLine: 15 });
  expect(msg[1]).toMatchObject({ fromLine: 19, toLine: 20 });
  expect(by("S-INSTR-IDENTITY").map((s) => s.line)).toEqual([3]);
  expect(f.repos.map((r) => r.path.split("/").pop()).sort()).toEqual(["bff", "chameleon", "e2e", "ios", "kmp"]);
  expect(by("S-REPO-AGENT-DEF").filter((s) => !s.claudeMdOnly).map((s) => s.name)).toEqual(["ios"]);
  expect(by("S-REPO-AGENT-DEF").filter((s) => s.claudeMdOnly).length).toBe(4);
  expect(by("S-STATE-DIR").map((s) => s.path)).toContain(join(home, ".bus/inbox"));
  expect(f.signals.map((s) => s.ref)).toEqual(f.signals.map((_, i) => "g" + (i + 1)));
  expect(f.roots[0]).toBe(ws);
});

test("never opens secret files and never leaks env values", () => {
  const opened: string[] = [];
  collectFacts(ws, { ...none, onRead: (p) => opened.push(p) });
  expect(opened.length).toBeGreaterThan(3);
  expect(opened.some((p) => p.endsWith(".env"))).toBe(false);
  expect(JSON.stringify(collectFacts(ws, none))).not.toContain("abc123");
});

test("runners: tmux, crontab and launchd flag by behaviour; agentnet sessions are ignored", () => {
  const f = collectFacts(ws, {
    tmux: () => `ios\tclaude\t${ws}/ios\tclaude --resume\nagentnet-root\tclaude\t${ws}\tclaude\nplain\tzsh\t/tmp\tzsh\n`,
    crontab: () => `# comment\n*/5 * * * * cd ${ws} && ./bin/pull-msgs.sh\n0 1 * * * /usr/bin/backup\n`,
    launchd: () => [{ file: "/x/a.plist", label: "a", args: ["/usr/bin/claude", "-p", "go"] }, { file: "/x/b.plist", label: "b", args: ["/bin/ls"] }],
  });
  expect(f.signals.filter((s) => s.id === "S-RUNNER-TMUX").map((s) => s.session)).toEqual(["ios"]);
  expect(f.signals.filter((s) => s.id === "S-RUNNER-CRON").length).toBe(1);
  expect(f.signals.filter((s) => s.id === "S-RUNNER-LAUNCHD").map((s) => s.label)).toEqual(["a"]);
});

test("a failing runner is a skipped entry, not an error", () => {
  const boom = () => { throw new Error("no server"); };
  const f = collectFacts(ws, { tmux: boom, crontab: boom, launchd: boom });
  expect(f.skipped.map((s) => s.what).sort()).toEqual(["S-RUNNER-CRON", "S-RUNNER-LAUNCHD", "S-RUNNER-TMUX"]);
});

test("limits add a skipped entry", () => {
  let t = 0;
  const f = collectFacts(ws, { ...none, now: () => (t += 3000) });
  expect(f.skipped.some((s) => s.what === "limits")).toBe(true);
  expect(LIMITS.files).toBe(200);
  const many = join(ws, "docs"); fs.mkdirSync(join(ws, ".claude/rules"), { recursive: true });
  for (let i = 0; i < 210; i++) fs.writeFileSync(join(ws, ".claude/rules", `r${String(i).padStart(3, "0")}.md`), "x\n");
  void many;
  expect(collectFacts(ws, none).skipped.some((s) => s.why.includes("200 file"))).toBe(true);
});

test("no product names in adopt source", () => {
  const names = ["agmsg", "swarmkit", "claude-flow", "mcp-agent-mail", "crewai", "autogen", "langgraph", "openclaw"];
  const dir = join(import.meta.dir);
  const srcs = readdirSync(dir).filter((f) => /^adopt.*\.ts$/.test(f) && !f.endsWith(".test.ts") && f !== "adopt-legacy.ts").map((f) => join(dir, f));
  const assets = join(import.meta.dir, "../../assets/director");
  try { for (const f of readdirSync(assets)) srcs.push(join(assets, f)); } catch { /* not built yet */ }
  for (const f of srcs) for (const n of names) expect([f, readFileSync(f, "utf8").toLowerCase().includes(n)]).toEqual([f, false]);
});

test("an MCP server named after a message tool (harbormsg, fastmail) is found; a plain one is not", () => {
  const { stemHits } = require("./adopt-scan") as typeof import("./adopt-scan");
  expect(stemHits("harbormsg")).toEqual(["msg"]);
  expect(stemHits("/h/scripts/fastmail/run.sh")).toEqual(["mail"]);
  expect(stemHits("lint-mcp")).toEqual([]);
  fs.writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { harbormsg: { command: "/h/scripts/harbormsg/mcp.sh", env: { K: "sk-live-9999999999" } }, notes: { command: "notes-mcp" } } }));
  const f = collectFacts(ws, none);
  expect(f.signals.filter((s) => s.id === "S-MCP" && s.file === join(home, ".claude.json")).map((s) => s.server)).toEqual(["harbormsg"]);
});
