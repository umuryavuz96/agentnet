// Parking a hook in many repos and an MCP server in the user's own ~/.claude.json. HOME is a scratch folder; nothing real is read or written.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFacts } from "./adopt-scan";
import { validateReport } from "./adopt-report";
import { staticReport } from "./adopt";
import { buildPlan } from "./adopt-plan";
import { applyPlan, rollbackRun } from "./adopt-apply";
import { cutMember, mcpHolders, putMember } from "./adopt-json";

let tmp = "", home = "", ws = "", root = "", oldHome: string | undefined;
const none = { tmux: () => "", crontab: () => "", launchd: () => [] };
const SECRET = "sk-live-SECRETVALUE-0123456789";
const w = (p: string, body: string) => { mkdirSync(join(p, "..", "x").replace(/\/x$/, ""), { recursive: true }); writeFileSync(p, body); };
// formatting a JSON.stringify round trip would change: odd spacing, 1.0, escapes, big number, trailing newline absent
const claudeJson = () => `{"numStartups":  12,\n  "history": [{"display":"caf\\u00e9 \\"quoted\\"","pasted":1.0,"big":12345678901234567890}],\n  "mcpServers": {\n    "keep-me":{"command":"x"},\n    "msg-bus": {"command":"msg-bus-mcp","args":["inbox"],"env":{"BUS_KEY":"${SECRET}"}},\n    "tail": {"command":"y"}\n  },\n  "projects": {"/a": {"mcpServers": {}}},\n  "pad": "${"p".repeat(260 * 1024)}"\n}`;
const hookSettings = (script: string) => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `$CLAUDE_PROJECT_DIR/bin/${script}` }] }] } }, null, 2) + "\n";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "adopt-global-")); home = join(tmp, "home"); ws = join(tmp, "work"); root = join(tmp, "agentnet");
  oldHome = process.env.HOME; process.env.HOME = home;
  mkdirSync(home, { recursive: true });
  w(join(home, ".claude.json"), claudeJson());
  w(join(ws, "CLAUDE.md"), "# ws\n");
  for (let i = 1; i <= 7; i++) {
    const r = join(ws, `repo${i}`);
    w(join(r, ".git/HEAD"), "ref: refs/heads/main\n");
    w(join(r, ".claude/settings.json"), hookSettings("check-inbox.sh"));
    if (i <= 3) w(join(r, ".claude/settings.local.json"), hookSettings("poll-inbox.sh"));
    w(join(r, "bin/check-inbox.sh"), "#!/bin/sh\ncat ~/.bus/inbox\n");
    w(join(r, "bin/poll-inbox.sh"), "#!/bin/sh\ncat ~/.bus/inbox\n");
  }
});
afterEach(() => { process.env.HOME = oldHome; rmSync(tmp, { recursive: true, force: true }); });

function planFor() {
  const facts = collectFacts(ws, none);
  const sr = staticReport(facts);
  const v = validateReport({ summary: sr.summary, findings: sr.findings }, facts);
  if (!v.ok) throw new Error(v.errors.join("; "));
  const f = v.report.findings.find((x) => x.kind === "coordination-system")!;
  const p = buildPlan(v.report, { findings: { [f.id]: "apply" } }, { runId: "run-20261110-120000", root, workspaceDir: join(root, "workspace") });
  if (!p.ok) throw new Error(p.errors.join("; "));
  return { facts, f, plan: p.plan };
}

test("json member surgery: cut and put back are byte exact", () => {
  const t = claudeJson();
  expect(mcpHolders(t, "msg-bus")).toEqual([["mcpServers"]]);
  const c = cutMember(t, ["mcpServers"], "msg-bus");
  expect(c.text).toBe(t.replace(/,\n    "msg-bus".*?\}\}(?=,\n    "tail")/s, "").replace(/"keep-me":\{"command":"x"\},\n    "tail"/, '"keep-me":{"command":"x"},\n    "tail"'));
  expect(() => JSON.parse(c.text)).not.toThrow();
  expect(c.text).not.toContain(SECRET);
  for (const server of ["keep-me", "tail"]) { const k = cutMember(t, ["mcpServers"], server); expect(() => JSON.parse(k.text)).not.toThrow(); const back = putMember(k.text, ["mcpServers"], server, k.raw); expect(JSON.parse(back)).toEqual(JSON.parse(t)); expect(back.length).toBeGreaterThanOrEqual(k.text.length + k.raw.length); }
  expect(JSON.parse(putMember(c.text, ["mcpServers"], "msg-bus", c.raw))).toEqual(JSON.parse(t));
  expect(() => putMember(t, ["mcpServers"], "tail", "x")).toThrow(/already/);
});

test("hooks in 7 repos become one finding with one park-hook per settings file", () => {
  const { f, plan } = planFor();
  const hooks = f.actions.filter((a) => a.op === "park-hook");
  expect(hooks.length).toBe(10); // 7 settings.json + 3 settings.local.json
  expect(new Set(hooks.map((a) => (a as { file: string }).file)).size).toBe(10);
  expect(plan.ops.filter((o) => o.op === "park-hook").length).toBe(10);
});

test("global MCP: scanned, planned, applied by entry, every other byte kept, secrets stay out of plan and manifest", async () => {
  const before = readFileSync(join(home, ".claude.json"), "utf8"), modeBefore = statSync(join(home, ".claude.json")).mode & 0o777;
  expect(statSync(join(home, ".claude.json")).size).toBeGreaterThan(200 * 1024);
  const { f, plan } = planFor();
  const mcp = f.actions.find((a) => a.op === "park-mcp");
  expect(mcp && "file" in mcp && mcp.file).toBe(join(home, ".claude.json"));
  expect(plan.needsConfirmGlobal).toBe(true);
  expect(JSON.stringify(plan)).not.toContain(SECRET);
  const r = await applyPlan(plan, { root, workspaceDir: join(root, "workspace"), confirmGlobal: true });
  if (!r.ok) throw new Error(r.error);
  const after = readFileSync(join(home, ".claude.json"), "utf8");
  expect(after).not.toContain("msg-bus");
  expect(JSON.parse(after).pad).toBe(JSON.parse(before).pad);
  expect(after.replace(/"msg-bus"[\s\S]*?\}\}\s*,?/, "")).not.toBe(before); // changed only there
  expect(after.startsWith('{"numStartups":  12,\n  "history": [{"display":"caf\\u00e9 \\"quoted\\"","pasted":1.0,"big":12345678901234567890}]')).toBe(true);
  expect(JSON.stringify(r.manifest)).not.toContain(SECRET);
  expect(statSync(join(home, ".claude.json")).mode & 0o777).toBe(modeBefore);
  const parkedFiles = readdirSync(join(r.runDir, "parked")); expect(parkedFiles.length).toBe(1); expect(statSync(join(r.runDir, "parked", parkedFiles[0])).mode & 0o777).toBe(0o600);

  // Claude Code rewrote the file in the meantime: undo puts back only our entry
  writeFileSync(join(home, ".claude.json"), after.replace('"numStartups":  12', '"numStartups":  99'));
  const u = rollbackRun(plan.runId, { root, workspaceDir: join(root, "workspace") });
  expect(u.ok).toBe(true);
  const back = readFileSync(join(home, ".claude.json"), "utf8");
  expect(JSON.parse(back).mcpServers["msg-bus"].env.BUS_KEY).toBe(SECRET);
  expect(JSON.parse(back).numStartups).toBe(99);
  expect(Object.keys(JSON.parse(back).mcpServers).sort()).toEqual(["keep-me", "msg-bus", "tail"]);
});

test("global MCP: untouched file is restored byte for byte, hooks too (Reset path)", async () => {
  const snap = () => [join(home, ".claude.json"), ...[1, 2, 3, 4, 5, 6, 7].flatMap((i) => [join(ws, `repo${i}`, ".claude/settings.json"), ...(i <= 3 ? [join(ws, `repo${i}`, ".claude/settings.local.json")] : [])])].map((p) => readFileSync(p, "utf8"));
  const orig = snap();
  const { plan } = planFor();
  const r = await applyPlan(plan, { root, workspaceDir: join(root, "workspace"), confirmGlobal: true });
  if (!r.ok) throw new Error(r.error);
  expect(snap()).not.toEqual(orig);
  expect(readFileSync(join(ws, "repo1/.claude/settings.json"), "utf8")).not.toContain("check-inbox");
  const u = rollbackRun(plan.runId, { root, workspaceDir: join(root, "workspace") });
  expect(u.kept).toEqual([]);
  expect(snap()).toEqual(orig);
});

test("global MCP: entry already re-added by the user is kept, not duplicated", async () => {
  const { plan } = planFor();
  const r = await applyPlan(plan, { root, workspaceDir: join(root, "workspace"), confirmGlobal: true });
  if (!r.ok) throw new Error(r.error);
  const cur = readFileSync(join(home, ".claude.json"), "utf8");
  writeFileSync(join(home, ".claude.json"), cur.replace('"tail"', '"msg-bus": {"command":"mine"},\n    "tail"'));
  const u = rollbackRun(plan.runId, { root, workspaceDir: join(root, "workspace") });
  expect(u.kept.some((k) => k.file === join(home, ".claude.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers["msg-bus"].command).toBe("mine");
});
