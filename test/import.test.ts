// Step 4: the import fills claude/base from a scratch HOME's ~/.claude (SPEC-step4-import.md). Sources are only read: HOME stays byte-identical.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-imp-"));
const { Database } = await import("bun:sqlite");
const { useDatabase } = await import("../src/core/db");
useDatabase(new Database(":memory:"));
const { ROOT } = await import("../src/core/config");
const st = await import("../src/net/store");
const rt = await import("../src/net/routes");
const teams = await import("../src/net/teams");
const imp = await import("../src/net/agent-import");
const { buildApp, makeFetch } = await import("../src/server");
const { rootToken } = await import("./helpers");

const SECRET = "s3cret-fixture";
const HOME0 = process.env.HOME;
let HOME = "";
const base = join(ROOT, "claude", "base");
const seams0 = { ...imp.importSeams };
afterAll(() => { process.env.HOME = HOME0; Object.assign(imp.importSeams, seams0); rmSync(base, { recursive: true, force: true }); rmSync(join(ROOT, "agents"), { recursive: true, force: true }); });

/** The fixture ~/.claude: CLAUDE.md, 2 rules, 1 skill dir, 1 agent def, 1 command, 2 hooks (one script under ~/.claude/hooks), env with a secret, 2 MCP servers, 1 plugin. */
function fixture(): string {
  const h = mkdtempSync(join(tmpdir(), "an-imp-home-")), c = join(h, ".claude");
  for (const d of ["rules", "skills/s1", "agents", "commands", "hooks", "plugins"]) mkdirSync(join(c, d), { recursive: true });
  writeFileSync(join(c, "CLAUDE.md"), "# global rules\n");
  writeFileSync(join(c, "rules", "a.md"), "rule a\n"); writeFileSync(join(c, "rules", "b.md"), "rule b\n");
  writeFileSync(join(c, "skills", "s1", "SKILL.md"), "---\nname: s1\n---\nskill\n");
  writeFileSync(join(c, "agents", "helper.md"), "---\nname: helper\n---\nhelps\n");
  writeFileSync(join(c, "commands", "c.md"), "do c\n");
  writeFileSync(join(c, "hooks", "x.sh"), "#!/bin/sh\necho x\n"); chmodSync(join(c, "hooks", "x.sh"), 0o755);
  writeFileSync(join(c, "settings.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "bash ~/.claude/hooks/x.sh" }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/true" }] }] },
    env: { FOO: "1", API_TOKEN: SECRET }, model: "sonnet", permissions: { allow: ["Bash(ls)"] },
  }, null, 2));
  writeFileSync(join(c, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "demo@market": [{ scope: "user" }] } }));
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { pigeon: { command: "pigeon-mcp" }, notes: { type: "http", url: "http://127.0.0.1:1/mcp" } } }, null, 2));
  return h;
}
const snapshot = (d: string, out = new Map<string, string>()): Map<string, string> => {
  if (!existsSync(d)) return out;
  for (const n of readdirSync(d)) { const p = join(d, n), s = statSync(p); if (s.isDirectory()) snapshot(p, out); else out.set(p, `${s.size} ${createHash("sha256").update(readFileSync(p)).digest("hex")} ${s.mtimeMs}`); }
  return out;
};
const contents = (d: string) => new Map([...snapshot(d)].map(([k, v]) => [k, v.split(" ").slice(0, 2).join(" ")]));
const noTmux = () => "";
const spawned: string[] = [];
const fakeSpawn = async (d: { name: string; boss: string; team: string | null; model: string | null }) => { spawned.push(d.name); rt.createAgent({ name: d.name, boss: d.boss, job: "imported", by: "root", standing: true }); if (d.team && teams.getTeam(d.team)) teams.addMember(d.team, d.name); return { ok: true }; };

beforeEach(() => {
  useDatabase(new Database(":memory:")); st._reset(); imp._resetImport();
  rmSync(base, { recursive: true, force: true }); rmSync(join(ROOT, "agents"), { recursive: true, force: true }); rmSync(join(ROOT, "workspace"), { recursive: true, force: true });
  HOME = fixture(); process.env.HOME = HOME;
  spawned.length = 0;
  Object.assign(imp.importSeams, { spawn: fakeSpawn, hasSession: () => false, kill: () => {} });
});

test("import: collect lists every source with targets and badges", () => {
  const seen: unknown[] = [], off = imp.onProgress((p) => seen.push(p));
  const r = imp.startScan({ tmux: noTmux }); off();
  expect(r.ok).toBe(true);
  const items = imp.currentRun()!.items, count = (k: string) => items.filter((i) => i.kind === k).length;
  expect([count("instruction"), count("rule"), count("skill"), count("agent-def"), count("command"), count("hook"), count("settings-env"), count("mcp"), count("plugin"), count("agent"), count("team")]).toEqual([1, 2, 1, 1, 1, 2, 3, 2, 1, 0, 0]);
  const by = (id: string) => items.find((i) => i.id === id)!;
  expect(by("instruction:CLAUDE.md").target).toBe("claude/base/CLAUDE.md");
  expect(by("rule:a.md").target).toBe("claude/base/rules/a.md");
  expect(by("skill:s1").target).toBe("claude/base/skills/s1");
  expect(by("agent-def:helper.md").target).toBe("claude/base/agents/helper.md");
  expect(by("command:c.md").target).toBe("claude/base/commands/c.md");
  expect(by("hook:Stop:0:0").badges).toEqual([]); expect(by("hook:Stop:0:0").at?.script).toBe(join(HOME, ".claude", "hooks", "x.sh"));
  expect(by("hook:PreToolUse:0:0").badges).toEqual([imp.BADGE.outside]);
  expect(by("env:API_TOKEN")).toMatchObject({ accept: false, badges: [imp.BADGE.secret] });
  expect(by("env:FOO")).toMatchObject({ accept: true, badges: [] });
  expect(by("settings:keys").summary).toContain("model, permissions");
  expect(by("mcp:pigeon").target).toBe("claude/base/mcp.json");
  expect(by("plugin:demo@market")).toMatchObject({ accept: false, badges: [imp.BADGE.manual], target: "" });
  const all = JSON.stringify(items) + JSON.stringify(seen) + JSON.stringify(imp.recentProgress());
  expect(all).not.toContain(SECRET);
  // the run file and the server log never hold the value either
  expect(readFileSync(join(ROOT, "import", r.ok ? r.runId : "", "run.json"), "utf8")).not.toContain(SECRET);
  const logs = join(ROOT, "logs"); if (existsSync(logs)) for (const f of readdirSync(logs)) expect(readFileSync(join(logs, f), "utf8")).not.toContain(SECRET);
});

test("import: preview shows hook rewrite diff and every target file", () => {
  imp.startScan({ tmux: noTmux });
  expect(imp.decide({ items: [{ id: "env:API_TOKEN", accept: true }] }).ok).toBe(true);
  const p = imp.preview();
  if (!p.ok) throw new Error(p.errors.join("; "));
  const rw = p.plan.ops.find((o) => o.op === "rewrite-hook-path") as { diff: string; target: string; from: string; to: string };
  expect(rw.target).toBe("claude/base/hooks/x.sh");
  expect(rw.diff).toContain("-bash ~/.claude/hooks/x.sh"); expect(rw.diff).toContain(`+bash ${join(ROOT, "claude", "base", "hooks", "x.sh")}`);
  const targets = p.plan.files.map((f) => f.target).sort();
  expect(targets).toEqual(["claude/base/.complete", "claude/base/CLAUDE.md", "claude/base/agents/helper.md", "claude/base/commands/c.md", "claude/base/hooks/x.sh", "claude/base/mcp.json", "claude/base/rules/a.md", "claude/base/rules/b.md", "claude/base/settings.json", "claude/base/skills/s1/SKILL.md"]);
  expect(p.plan.files.every((f) => f.target === "claude/base/.complete" || f.size > 0)).toBe(true);
  expect(p.plan.ops.map((o) => o.op).at(-1)).toBe("mark-complete");
  // the settings diff names the secret key but never its value, even when accepted
  expect(JSON.stringify(p.plan)).not.toContain(SECRET);
  expect((p.plan.ops.find((o) => o.op === "write-base-settings") as { diff: string }).diff).toContain('"API_TOKEN": "***"');
});

test("import: apply fills claude/base, writes .complete last and leaves HOME byte-identical", async () => {
  const before = snapshot(HOME);
  imp.startScan({ tmux: noTmux });
  const p = imp.preview(); if (!p.ok) throw new Error(p.errors.join("; "));
  const seen: { op?: string; status?: string }[] = [], off = imp.onProgress((e) => seen.push(e));
  const a = await imp.applyImport(p.plan.planId); off();
  if (!a.ok) throw new Error(a.error);
  for (const f of ["CLAUDE.md", "rules/a.md", "rules/b.md", "skills/s1/SKILL.md", "agents/helper.md", "commands/c.md", "hooks/x.sh", "settings.json", "mcp.json", ".complete"]) expect(existsSync(join(base, f))).toBe(true);
  const s = JSON.parse(readFileSync(join(base, "settings.json"), "utf8"));
  expect(s.hooks.Stop[0].hooks[0].command).toBe(`bash ${join(base, "hooks", "x.sh")}`);
  expect(s.hooks.PreToolUse[0]).toEqual({ matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/true" }] });
  expect(s.env).toEqual({ FOO: "1" }); expect(s.model).toBe("sonnet");
  expect(Object.keys(JSON.parse(readFileSync(join(base, "mcp.json"), "utf8")).mcpServers)).toEqual(["pigeon", "notes"]);
  expect(statSync(join(base, "hooks", "x.sh")).mode & 0o777).toBe(0o700);
  expect(JSON.parse(readFileSync(join(base, ".complete"), "utf8")).runId).toBe(a.runId);
  const fileOps = seen.filter((e) => e.op && e.status === "ok").map((e) => e.op);
  expect(fileOps.at(-1)).toBe("mark-complete");
  expect(a.manifest.files.at(-1)!.target).toBe(join(base, ".complete"));
  expect(snapshot(HOME)).toEqual(before);
  expect(JSON.stringify(seen)).not.toContain(SECRET);
});

test("import: apply keeps hooks-page keys in base settings", async () => {
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo page-hook" }] }] }, model: "opus", statusLine: { type: "command", command: "page-status" } }, null, 2));
  imp.startScan({ tmux: noTmux });
  const p = imp.preview(); if (!p.ok) throw new Error(p.errors.join("; "));
  const ws = p.plan.ops.find((o) => o.op === "write-base-settings") as { conflicts: string[] };
  expect(ws.conflicts).toEqual(["model"]); // both sides set it: the import's value wins and the preview says so
  expect(p.plan.warnings).toContain("base settings: the import's value replaces model");
  const a = await imp.applyImport(p.plan.planId); if (!a.ok) throw new Error(a.error);
  const s = JSON.parse(readFileSync(join(base, "settings.json"), "utf8"));
  expect(s.hooks.Stop[0].hooks.map((h: { command: string }) => h.command)).toEqual(["echo page-hook", `bash ${join(base, "hooks", "x.sh")}`]);
  expect(s.statusLine).toEqual({ type: "command", command: "page-status" });
  expect(s.model).toBe("sonnet");
  // rollback puts the page's file back exactly
  const rb = imp.rollbackImport(a.runId); expect(rb.ok).toBe(true);
  expect(JSON.parse(readFileSync(join(base, "settings.json"), "utf8")).model).toBe("opus");
});

test("import: source changed after preview stops the run before agent ops", async () => {
  imp.startScan({ tmux: () => "worker\tclaude\t/tmp\tclaude\n" });
  expect(imp.currentRun()!.items.some((i) => i.id === "agent:worker")).toBe(true);
  const p = imp.preview(); if (!p.ok) throw new Error(p.errors.join("; "));
  writeFileSync(join(HOME, ".claude", "rules", "b.md"), "rule b, edited\n");
  const a = await imp.applyImport(p.plan.planId);
  expect(a.ok).toBe(false);
  if (!a.ok) { expect(a.status).toBe(409); expect(a.error).toContain("changed since preview"); }
  expect(spawned).toEqual([]);
  expect(existsSync(join(base, ".complete"))).toBe(false);
  const ops = imp.currentRun()!.plan!.ops;
  expect(ops.find((o) => o.op === "copy-file" && o.target === "claude/base/rules/b.md")).toMatchObject({ status: "failed", error: expect.stringContaining("changed since preview") });
  expect(ops.filter((o) => o.op === "start-agent" || o.op === "create-agent").every((o) => o.status === "skipped")).toBe(true);
  expect(imp.currentRun()!.phase).toBe("failed");
});

test("import: rollback removes exactly the manifest, .complete first", async () => {
  mkdirSync(join(base, "rules"), { recursive: true }); writeFileSync(join(base, "rules", "mine.md"), "kept\n"); // not the import's: stays
  const before = contents(join(ROOT, "claude")), agentsBefore = contents(join(ROOT, "agents"));
  imp.startScan({ tmux: () => "worker\tclaude\t/tmp\tclaude\n" });
  const p = imp.preview(); if (!p.ok) throw new Error(p.errors.join("; "));
  const a = await imp.applyImport(p.plan.planId); if (!a.ok) throw new Error(a.error);
  expect(spawned).toEqual(["worker"]); expect(existsSync(join(ROOT, "agents", "worker", "staff.json"))).toBe(true);
  const rb = imp.rollbackImport(a.runId);
  expect(rb.ok).toBe(true);
  expect(rb.order).toEqual(["complete", "agents", "teams", "files"]);
  expect(rb.removed[0]).toBe(join(base, ".complete"));
  expect(rb.agents).toEqual(["worker"]); expect(rt.byName("worker")).toBeNull();
  const listed = new Set(a.manifest.files.map((f) => f.target));
  expect(rb.removed.every((f) => listed.has(f))).toBe(true);
  expect(contents(join(ROOT, "claude"))).toEqual(before);
  expect(contents(join(ROOT, "agents"))).toEqual(agentsBefore);
  expect(readFileSync(join(base, "rules", "mine.md"), "utf8")).toBe("kept\n");
  expect(imp.rollbackImport(a.runId).error).toBe("already rolled back");
});

test("import: skipped CLAUDE.md and rules means no .complete", async () => {
  imp.startScan({ tmux: noTmux });
  expect(imp.decide({ items: [{ id: "instruction:CLAUDE.md", accept: false }, { id: "rule:a.md", accept: false }, { id: "rule:b.md", accept: false }] }).ok).toBe(true);
  const p = imp.preview(); if (!p.ok) throw new Error(p.errors.join("; "));
  expect(p.plan.ops.some((o) => o.op === "mark-complete")).toBe(false);
  const a = await imp.applyImport(p.plan.planId); if (!a.ok) throw new Error(a.error);
  expect(existsSync(join(base, "skills", "s1", "SKILL.md"))).toBe(true);
  expect(existsSync(join(base, ".complete"))).toBe(false);
});

test("import: agents created standing, director first, then leads, then members", async () => {
  const report = { workspace: "/x", scanId: "s", findings: [
    { id: "f1", kind: "coordination-system", title: "Core crew", about: "a lead and a member", confidence: "high", risk: "low", agents: ["mem-b", "lead-a"], evidence: [], suggestion: "keep-as-is", actions: [] },
    { id: "f2", kind: "identity-claim", title: "Main", about: "the main session", confidence: "high", risk: "low", agents: ["boss-x"], evidence: [], suggestion: "keep-as-is", actions: [] },
  ] } as never;
  imp.startScan({ tmux: noTmux, llm: true, report });
  const items = imp.currentRun()!.items;
  expect(items.filter((i) => i.kind === "agent").map((i) => i.edits?.name)).toEqual(["mem-b", "lead-a", "boss-x"]);
  // the owner picks the lead and edits a model; a bad edit is refused
  expect(imp.decide({ items: [{ id: "agent:mem-b", accept: true, edits: { model: "gpt-9" } }] }).ok).toBe(false);
  expect(imp.decide({ items: [{ id: "agent:mem-b", accept: true, edits: { name: "Bad Name" } }] }).ok).toBe(false);
  expect(imp.decide({ items: [{ id: "team:core-crew", accept: true, edits: { lead: "lead-a", members: ["lead-a", "mem-b"] } }, { id: "agent:mem-b", accept: true, edits: { boss: "lead-a", model: "haiku" } }, { id: "agent:lead-a", accept: true, edits: { boss: "boss-x" } }] }).ok).toBe(true);
  const p = imp.preview(); if (!p.ok) throw new Error(p.errors.join("; "));
  const ops = p.plan.ops.map((o) => o.op);
  expect(ops.indexOf("create-team")).toBeGreaterThan(ops.indexOf("mark-complete"));
  const a = await imp.applyImport(p.plan.planId); if (!a.ok) throw new Error(a.error);
  expect(spawned).toEqual(["boss-x", "lead-a", "mem-b"]);
  for (const n of spawned) expect(rt.byName(n)!.standing).toBe(1);
  const t = teams.getTeam("core-crew")!;
  expect(t.lead).toBe("lead-a"); expect(t.members.sort()).toEqual(["lead-a", "mem-b"]);
  const def = JSON.parse(readFileSync(join(ROOT, "agents", "mem-b", "staff.json"), "utf8"));
  expect(def).toMatchObject({ name: "mem-b", boss: "lead-a", model: "haiku", team: "core-crew", standing: true });
  const rb = imp.rollbackImport(a.runId);
  expect(rb.teams).toEqual(["core-crew"]); expect(teams.getTeam("core-crew")!.state).toBe("archived");
});

test("standing: running standing agent is restarted after server start, max 10", async () => {
  const mk = (name: string, standing: boolean) => rt.createAgent({ name, job: "j", boss: "root", by: "root", standing });
  for (let k = 0; k < 12; k++) mk(`st-${k}`, true);
  mk("plain-1", false);
  mk("alive-1", true);
  rt.createAgent({ name: "root", job: "r", by: "root", standing: true });
  st.flush();
  const restarted: string[] = [];
  Object.assign(imp.importSeams, { hasSession: (s: string) => s === "agentnet-alive-1", spawn: async (d: { name: string }) => { restarted.push(d.name); rt.createAgent({ name: d.name, job: "j", boss: "root", by: "root", standing: true }); return { ok: true }; } });
  process.env.AGENTNET_RESTART_STANDING = "0";
  expect(await imp.restartStanding()).toEqual([]);
  delete process.env.AGENTNET_RESTART_STANDING;
  const got = await imp.restartStanding();
  expect(got).toEqual(Array.from({ length: 10 }, (_, k) => `st-${k}`));
  expect(restarted).toEqual(got);
  expect(rt.byName("st-0")!.gen).toBe(2); // a new run of the same name
  expect(got).not.toContain("plain-1"); expect(got).not.toContain("alive-1"); expect(got).not.toContain("root");
});

test("import: routes 401 without token, 403 for agent token, 409 for a second scan", async () => {
  const f = makeFetch(buildApp()), tok = await rootToken();
  const agentTok = rt.createAgent({ name: "worker-9", job: "j", boss: "root", by: "root" }).token;
  const call = async (path: string, auth: string | null, b?: unknown) => {
    const r = await f(new Request(`http://x/api/v1${path}`, { method: b === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }), { requestIP: () => ({ address: "10.0.0.10" }) });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  expect((await call("/agent-import/scan", null, {})).status).toBe(401);
  expect((await call("/agent-import", null)).status).toBe(401);
  expect((await call("/agent-import/scan", agentTok, {})).status).toBe(403);
  const s1 = await call("/agent-import/scan", tok, {});
  expect(s1.status).toBe(200); expect(s1.json.runId).toMatch(/^imp-/);
  expect((await call("/agent-import/scan", tok, {})).status).toBe(409);
  const pr = await call("/agent-import/proposal", tok);
  expect(pr.status).toBe(200); expect(pr.json.items.length).toBeGreaterThan(10);
  expect(JSON.stringify(pr.json)).not.toContain(SECRET);
  expect((await call("/agent-import/cancel", tok, {})).status).toBe(200);
  expect((await call("/agent-import/scan", tok, {})).status).toBe(200);
});

test("import: GET /agent-import carries the applied plan with op states, no secret", async () => {
  imp.startScan({ tmux: noTmux });
  const p = imp.preview(); if (!p.ok) throw new Error(p.errors.join("; "));
  const a = await imp.applyImport(p.plan.planId); if (!a.ok) throw new Error(a.error);
  const f = makeFetch(buildApp()), tok = await rootToken();
  const r = await f(new Request("http://x/api/v1/agent-import", { headers: { authorization: `Bearer ${tok}` } }), { requestIP: () => ({ address: "10.0.0.10" }) });
  const text = await r.text(), v = JSON.parse(text);
  expect(r.status).toBe(200); expect(v.phase).toBe("applied");
  expect(v.plan.ops.length).toBe(p.plan.ops.length);
  expect(v.plan.ops.every((o: { status?: string }) => o.status === "ok")).toBe(true);
  expect(text.split(SECRET).length - 1).toBe(0);
});

test("import: works with llm off", async () => {
  const report = { workspace: "/x", scanId: "s", findings: [{ id: "f1", kind: "identity-claim", title: "Main", about: "x", confidence: "high", risk: "low", agents: ["boss-x"], evidence: [], suggestion: "keep-as-is", actions: [] }] } as never;
  imp.startScan({ tmux: noTmux, llm: false, report });
  expect(imp.currentRun()!.items.some((i) => i.kind === "agent" || i.kind === "team")).toBe(false);
  const p = imp.preview(); if (!p.ok) throw new Error(p.errors.join("; "));
  const a = await imp.applyImport(p.plan.planId); if (!a.ok) throw new Error(a.error);
  expect(existsSync(join(base, ".complete"))).toBe(true);
  expect(spawned).toEqual([]);
});
