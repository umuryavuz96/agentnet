import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFacts, type Facts } from "./adopt-scan";
import { validateReport } from "./adopt-report";
import { makeWorkspace } from "../../test/helpers/adoptFixture";

let tmp = "", ws = "", home = "", oldHome: string | undefined, facts: Facts;
const none = { tmux: () => "", crontab: () => "", launchd: () => [] };
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "adopt-report-")); ({ ws, home } = makeWorkspace(tmp)); oldHome = process.env.HOME; process.env.HOME = home; facts = collectFacts(ws, none); });
afterEach(() => { process.env.HOME = oldHome; rmSync(tmp, { recursive: true, force: true }); });
const ref = (id: string) => facts.signals.find((s) => s.id === id)!.ref;

type R = { summary: string; findings: Record<string, any>[] };
const good = (): R => ({
  summary: "Found one message system and 5 repo agents.",
  findings: [
    { id: "f1", kind: "coordination-system", title: "Second coordination system", about: "A hook, a tool and CLAUDE.md lines route messages elsewhere.", confidence: "high", risk: "medium", agents: ["IOS", "kmp"],
      evidence: [{ signal: ref("S-HOOK-INJECT"), path: join(ws, ".claude/settings.json"), quote: "TOKEN=abc123 pull" }, { signal: ref("S-MCP"), path: join(ws, ".mcp.json") }], suggestion: "switch-off",
      actions: [
        { id: "a1", op: "park-hook", file: join(ws, ".claude/settings.json"), event: "UserPromptSubmit", commandIncludes: "pull-msgs.sh", junk: 1 },
        { id: "a2", op: "park-mcp", file: join(ws, ".mcp.json"), server: "pigeon" },
      ] },
    { id: "f2", kind: "identity-claim", title: "CLAUDE.md names a main agent", about: "Line 3 gives the director a name.", confidence: "medium", risk: "low", agents: [],
      evidence: [{ signal: ref("S-INSTR-IDENTITY"), path: join(ws, "CLAUDE.md"), line: 3 }], suggestion: "neutralise-lines",
      actions: [{ id: "a3", op: "disable-lines", file: join(ws, "CLAUDE.md"), fromLine: 3, toLine: 3, why: "identity" }] },
    { id: "f3", kind: "agent-definitions", title: "Repo agents", about: "ios has its own definition.", confidence: "high", risk: "low", agents: ["ios"],
      evidence: [{ signal: ref("S-REPO-AGENT-DEF"), path: join(ws, "ios/.claude/agents/ios.md") }], suggestion: "adopt-as-souls",
      actions: [{ id: "a4", op: "register-souls", repo: join(ws, "ios"), name: "ios", source: "agent-def", defFile: join(ws, "ios/.claude/agents/ios.md") }] },
    { id: "f4", kind: "scheduled-runner", title: "Old agents run", about: "A tmux session runs them.", confidence: "low", risk: "low", agents: [],
      evidence: [{ signal: ref("S-HOOK-INJECT"), path: join(ws, "bin/pull-msgs.sh") }], suggestion: "manual", actions: [{ id: "a5", op: "manual", title: "Stop session", command: "tmux kill-session -t ios", why: "agentnet will not stop it" }] },
  ],
});
const bad = (mut: (r: R) => void) => { const r = good(); mut(r); const v = validateReport(r, facts); expect(v.ok).toBe(false); return v.ok ? [] : v.errors; };

test("valid report passes; unknown keys dropped; names lowercased; quote redacted", () => {
  const v = validateReport(good(), facts, { builtinRoles: ["ios"] });
  expect(v.ok).toBe(true); if (!v.ok) return;
  expect(v.report).toMatchObject({ version: 1, workspace: ws, scanner: "director" });
  expect(v.report.scanId).toMatch(/^scan-[a-z0-9]{8}$/);
  expect(v.report.findings[0].agents).toEqual(["ios", "kmp"]);
  expect(v.report.findings[0].evidence[0].quote).toBe("TOKEN=*** pull");
  expect(JSON.stringify(v.report)).not.toContain("junk");
  expect(v.report.findings[2].actions[0]).toMatchObject({ roleClash: true });
});

test("rejects paths outside scan roots, denied names and symlink escapes", () => {
  expect(bad((r) => { r.findings[0].actions[0].file = "/etc/passwd"; })).toContain("findings[0].actions[0].file: outside scan roots");
  expect(bad((r) => { r.findings[0].evidence[0].path = "relative/x"; })[0]).toContain("absolute");
  expect(bad((r) => { r.findings[0].evidence[0].path = join(ws, ".env"); })[0]).toContain("deny list");
  const out = join(tmp, "outside.txt"); writeFileSync(out, "x"); symlinkSync(out, join(ws, "esc.md"));
  expect(bad((r) => { r.findings[1].actions[0].file = join(ws, "esc.md"); })[0]).toContain("outside scan roots");
});
test("rejects unknown signal refs", () => {
  expect(bad((r) => { r.findings[0].evidence[0].signal = "g999"; })).toContain("findings[0].evidence[0].signal: unknown signal ref");
});
test("disable-lines: unrelated text, long range, out of file, bad numbers", () => {
  expect(bad((r) => { Object.assign(r.findings[1].actions[0], { fromLine: 5, toLine: 6 }); })[0]).toContain("does not contain any line the scan flagged");
  expect(bad((r) => { Object.assign(r.findings[1].actions[0], { fromLine: 1, toLine: 61 }); })[0]).toContain("longer than 60");
  expect(bad((r) => { Object.assign(r.findings[1].actions[0], { fromLine: 3, toLine: 40 }); })[0]).toContain("outside the file");
  expect(bad((r) => { Object.assign(r.findings[1].actions[0], { fromLine: 4, toLine: 2 }); })[0]).toContain("fromLine");
});
test("park-hook / park-mcp targets must exist", () => {
  expect(bad((r) => { Object.assign(r.findings[0].actions[0], { commandIncludes: "nothing-like-this" }); })[0]).toContain("no such hook");
  expect(bad((r) => { Object.assign(r.findings[0].actions[1], { server: "ghost" }); })[0]).toContain("no such MCP server");
});
test("register-souls: unknown repo or definition, bad name", () => {
  expect(bad((r) => { Object.assign(r.findings[2].actions[0], { repo: join(ws, "nope") }); }).length).toBeGreaterThan(0);
  expect(bad((r) => { Object.assign(r.findings[2].actions[0], { defFile: join(ws, "CLAUDE.md") }); })[0]).toContain("not an agent definition");
  expect(bad((r) => { Object.assign(r.findings[2].actions[0], { name: "Bad Name!" }); })[0]).toContain("not a valid agent name");
});
test("unknown op, duplicate ids, bad enums, empty actions", () => {
  expect(bad((r) => { r.findings[3].actions[0].op = "rm-rf"; })[0]).toContain("must be one of");
  expect(bad((r) => { r.findings[1].id = "f1"; })).toContain("findings[1].id: duplicate id");
  expect(bad((r) => { r.findings[0].kind = "weird"; })[0]).toContain("kind");
  expect(bad((r) => { r.findings[0].actions = []; })[0]).toContain("empty only for keep-as-is and manual");
});
test("oversize and wrong shape", () => {
  expect(bad((r) => { r.findings[0].about = "x".repeat(70_000); }).length).toBeGreaterThan(0);
  expect(validateReport("nope", facts).ok).toBe(false);
  expect(validateReport({ summary: "x", findings: "no" }, facts).ok).toBe(false);
});
test("global file raises risk and sets the flag", () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  const gs = join(home, ".claude/settings.json");
  writeFileSync(gs, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-all.sh" }] }] } }));
  facts = collectFacts(ws, none);
  const r = good();
  r.findings[2].actions = [{ id: "a4", op: "park-hook", file: gs, event: "Stop", commandIncludes: "notify-all" } as never];
  r.findings[2].suggestion = "switch-off";
  r.findings[2].evidence[0].path = gs; r.findings[2].evidence[0].signal = facts.signals.find((s) => s.id === "S-HOOK-INJECT" && s.file === gs)!.ref;
  const v = validateReport(r, facts);
  expect(v.ok).toBe(true); if (v.ok) expect(v.report.findings[2]).toMatchObject({ global: true, risk: "medium" });
});
test("more than 40 findings keeps the riskiest 40 and reports the rest", () => {
  const r = good();
  const f = r.findings[3];
  r.findings = Array.from({ length: 45 }, (_, i) => ({ ...f, id: `f${i + 1}`, risk: i === 44 ? "high" : "low", actions: [{ ...f.actions[0], id: `a${i + 1}` }] })) as never;
  const v = validateReport(r, facts);
  expect(v.ok).toBe(true); if (!v.ok) return;
  expect(v.report.findings.length).toBe(40); expect(v.report.omitted).toBe(5); expect(v.report.findings[0].id).toBe("f45");
});
