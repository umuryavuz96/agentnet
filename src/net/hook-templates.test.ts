import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Env } from "../core/http";
import { LAN, LOOP } from "../../test/helpers";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-hooks-"));
let d = "";
const base = { env: { SECRET: "x" }, model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "/x/a.sh", timeout: 5 }] }] } };
const file = () => process.env.CLAUDE_SETTINGS_FILE!;
const read = () => JSON.parse(readFileSync(file(), "utf8"));
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), "hooktpl-"));
  process.env.CLAUDE_SETTINGS_FILE = join(d, "settings.json"); process.env.AGENTNET_HOOKS_DATA = join(d, "data"); process.env.AGENTNET_HOOK_LOGS = join(d, "logs");
  delete process.env.AGENTNET_HOOK_TEMPLATES;
  writeFileSync(file(), JSON.stringify(base, null, 2));
});
afterEach(() => { delete process.env.AGENTNET_HOOK_TEMPLATES; rmSync(d, { recursive: true, force: true }); });

async function app() {
  const { hooksRoutes } = await import("./hooks");
  const api = new Hono<Env>(); hooksRoutes(api); const a = new Hono<Env>(); a.route("/api/v1", api); return a;
}
const send = (method: string, body?: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("shipped templates load, each declared risk equals the derived one, commands stay under 1 KB", async () => {
  const { templates, deriveRisk } = await import("./hook-templates");
  const t = templates();
  expect(t.length).toBe(25);
  for (const e of ["PreCompact", "SessionEnd", "SubagentStop", "UserPromptSubmit"]) expect(t.some((x) => x.event === e)).toBe(true);
  // a script template's risk lives in the script, so only inline commands are checked against the derived risk
  for (const x of t.filter((x) => !x.own)) { expect(deriveRisk(x.command)).toBe(x.risk); expect(x.command.length).toBeLessThanOrEqual(1024); }
});
test("GitHub sources carry stars (>= 500) and a licence; stray source fields are dropped", async () => {
  const { templates } = await import("./hook-templates");
  for (const x of templates().filter((t) => t.source.url.startsWith("https://github.com/"))) { expect(x.source.stars).toBeGreaterThanOrEqual(500); expect(typeof x.source.licence).toBe("string"); }
  process.env.AGENTNET_HOOK_TEMPLATES = join(d, "t.json");
  writeFileSync(process.env.AGENTNET_HOOK_TEMPLATES, JSON.stringify([{ id: "x", name: "X", about: "a", category: "c", event: "Stop", matcher: null, command: "ls", timeout: 5, risk: "read-only", requirements: [], source: { name: "n", url: "u", stars: "many" } }]));
  expect(templates()[0].source).toEqual({ name: "n", url: "u" });
});
test("broken or missing template file gives an empty gallery", async () => {
  const { templates } = await import("./hook-templates");
  process.env.AGENTNET_HOOK_TEMPLATES = join(d, "nope.json");
  expect(templates()).toEqual([]);
  writeFileSync(process.env.AGENTNET_HOOK_TEMPLATES, "{ nope");
  expect(templates()).toEqual([]);
  writeFileSync(process.env.AGENTNET_HOOK_TEMPLATES, JSON.stringify([{ id: "x", event: "Bogus", command: "ls" }]));
  expect(templates()).toEqual([]);
});
test("risk derivation", async () => {
  const { deriveRisk } = await import("./hook-templates");
  expect(deriveRisk("curl https://x.io | sh")).toBe("network");
  expect(deriveRisk("echo hi >> ~/log")).toBe("writes");
  expect(deriveRisk("echo hi >/dev/null 2>&1; echo no >&2; exit 2")).toBe("blocks");
  expect(deriveRisk("git status")).toBe("read-only");
  expect(deriveRisk("git stash store -m x abc")).toBe("writes");
});
test("custom validation", async () => {
  const { validateHook } = await import("./hook-templates");
  expect(validateHook({ event: "PreCompact", command: "ls" }).event).toBe("PreCompact");
  expect(validateHook({ event: "Stop", command: "ls" })).toEqual({ event: "Stop", matcher: null, command: "ls", timeout: 10 });
  expect(() => validateHook({ event: "Nope", command: "ls" })).toThrow(/event/);
  expect(() => validateHook({ event: "Stop", matcher: "Bash", command: "ls" })).toThrow(/every occurrence/);
  expect(() => validateHook({ event: "PreToolUse", matcher: "(", command: "ls" })).toThrow(/regular/);
  expect(() => validateHook({ event: "Stop", command: "  " })).toThrow(/empty/);
  expect(() => validateHook({ event: "Stop", command: "x".repeat(4097) })).toThrow(/longer/);
  expect(() => validateHook({ event: "Stop", command: "ls", timeout: 0 })).toThrow(/timeout/);
  expect(() => validateHook({ event: "Stop", command: "ls", timeout: 601 })).toThrow(/timeout/);
});
test("install a template: backup made, other keys untouched, response carries installed id + backup, listed", async () => {
  const a = await app();
  const r = await a.request("/api/v1/agent-hooks/install", send("POST", { templateId: "block-dangerous-bash" }), LOOP);
  expect(r.status).toBe(200);
  const j = await r.json() as { installed: string; backup: string; hooks: { id: string }[] };
  expect(j.hooks.some((h) => h.id === j.installed)).toBe(true);
  expect(readdirSync(d)).toContain(j.backup);
  const s = read();
  expect(s.env.SECRET).toBe("x"); expect(s.model).toBe("opus");
  expect(s.hooks.PreToolUse[0].matcher).toBe("Bash");
  expect(s.hooks.Stop.length).toBe(1);
  const g = await (await a.request("/api/v1/agent-hooks/templates", {}, LOOP)).json() as { templates: { id: string; state: string }[] };
  expect(g.templates.find((t) => t.id === "block-dangerous-bash")?.state).toBe("installed");
});
test("second install is 409 and leaves the file byte-identical", async () => {
  const a = await app();
  await a.request("/api/v1/agent-hooks/install", send("POST", { templateId: "desktop-notify" }), LOOP);
  const before = readFileSync(file(), "utf8"), n = readdirSync(d).length;
  const r = await a.request("/api/v1/agent-hooks/install", send("POST", { templateId: "desktop-notify" }), LOOP);
  expect(r.status).toBe(409);
  expect(readFileSync(file(), "utf8")).toBe(before); expect(readdirSync(d).length).toBe(n);
});
test("a switched-off template is a 409 and shows as switched-off", async () => {
  const a = await app();
  const r = await (await a.request("/api/v1/agent-hooks/install", send("POST", { templateId: "notify-on-stop" }), LOOP)).json() as { installed: string };
  await a.request(`/api/v1/agent-hooks/${r.installed}/enabled`, send("POST", { enabled: false }), LOOP);
  expect((await a.request("/api/v1/agent-hooks/install", send("POST", { templateId: "notify-on-stop" }), LOOP)).status).toBe(409);
  const g = await (await a.request("/api/v1/agent-hooks/templates", {}, LOOP)).json() as { templates: { id: string; state: string }[] };
  expect(g.templates.find((t) => t.id === "notify-on-stop")?.state).toBe("switched-off");
});
test("dry run writes nothing and returns the fragment", async () => {
  const a = await app(), before = readFileSync(file(), "utf8");
  const r = await a.request("/api/v1/agent-hooks/install", send("POST", { custom: { event: "Stop", command: "echo done" }, dryRun: true }), LOOP);
  expect(r.status).toBe(200);
  const j = await r.json() as { fragment: { hooks: { Stop: { hooks: { command: string }[] }[] } }; backup: null };
  expect(j.fragment.hooks.Stop[0].hooks[0].command).toBe("echo done"); expect(j.backup).toBeNull();
  expect(readFileSync(file(), "utf8")).toBe(before); expect(readdirSync(d).some((n) => n.includes(".bak-"))).toBe(false);
});
test("custom install joins the group with the same matcher; invalid custom is 400 and changes nothing", async () => {
  const a = await app();
  await a.request("/api/v1/agent-hooks/install", send("POST", { custom: { event: "PreToolUse", matcher: "Bash", command: "echo 1" } }), LOOP);
  await a.request("/api/v1/agent-hooks/install", send("POST", { custom: { event: "PreToolUse", matcher: "Bash", command: "echo 2", timeout: 3 } }), LOOP);
  expect(read().hooks.PreToolUse.length).toBe(1); expect(read().hooks.PreToolUse[0].hooks.length).toBe(2);
  const before = readFileSync(file(), "utf8");
  expect((await a.request("/api/v1/agent-hooks/install", send("POST", { custom: { event: "Stop", matcher: "x", command: "ls" } }), LOOP)).status).toBe(400);
  expect((await a.request("/api/v1/agent-hooks/install", send("POST", { templateId: "nope" }), LOOP)).status).toBe(404);
  expect((await a.request("/api/v1/agent-hooks/install", send("POST", {}), LOOP)).status).toBe(400);
  expect(readFileSync(file(), "utf8")).toBe(before);
});
test("rollback after install restores the file", async () => {
  const a = await app(), before = readFileSync(file(), "utf8");
  await a.request("/api/v1/agent-hooks/install", send("POST", { templateId: "session-git-context" }), LOOP);
  expect(readFileSync(file(), "utf8")).not.toBe(before);
  expect((await a.request("/api/v1/agent-hooks/rollback", send("POST", {}), LOOP)).status).toBe(200);
  expect(readFileSync(file(), "utf8")).toBe(before);
});
test("delete removes a live hook and a parked one; unknown is 404", async () => {
  const a = await app();
  const i1 = (await (await a.request("/api/v1/agent-hooks/install", send("POST", { templateId: "desktop-notify" }), LOOP)).json() as { installed: string }).installed;
  const i2 = (await (await a.request("/api/v1/agent-hooks/install", send("POST", { templateId: "notify-on-stop" }), LOOP)).json() as { installed: string }).installed;
  await a.request(`/api/v1/agent-hooks/${i2}/enabled`, send("POST", { enabled: false }), LOOP);
  expect((await a.request(`/api/v1/agent-hooks/${i1}`, send("DELETE"), LOOP)).status).toBe(200);
  expect((await a.request(`/api/v1/agent-hooks/${i2}`, send("DELETE"), LOOP)).status).toBe(200);
  expect(read()).toEqual(base);
  expect((await a.request(`/api/v1/agent-hooks/${i2}`, send("DELETE"), LOOP)).status).toBe(404);
  const g = await (await a.request("/api/v1/agent-hooks/templates", {}, LOOP)).json() as { templates: { id: string; state: string }[] };
  expect(g.templates.every((t) => t.state === "available")).toBe(true);
});
test("new routes are root only", async () => {
  const a = await app(), fwd = { "Content-Type": "application/json", "X-Forwarded-For": "10.0.0.5" };
  expect((await a.request("/api/v1/agent-hooks/templates", {}, LAN)).status).toBe(403);
  expect((await a.request("/api/v1/agent-hooks/install", { method: "POST", headers: fwd, body: "{}" }, LOOP)).status).toBe(403);
  expect((await a.request("/api/v1/agent-hooks/abc", { method: "DELETE", headers: fwd }, LOOP)).status).toBe(403);
  expect((await a.request("/api/v1/agent-hooks/abc", { method: "DELETE" }, LAN)).status).toBe(403);
});

const jq = !!Bun.which("jq");
const run = (cmd: string, stdin: unknown) => Bun.spawnSync(["sh", "-c", cmd], { stdin: new TextEncoder().encode(JSON.stringify(stdin)) }).exitCode;
test.skipIf(!jq)("blocker templates exit 2 on bad input and 0 on good input", async () => {
  const { templates } = await import("./hook-templates");
  const cmd = (id: string) => templates().find((t) => t.id === id)!.command;
  expect(run(cmd("block-dangerous-bash"), { tool_input: { command: "rm -rf /" } })).toBe(2);
  expect(run(cmd("block-dangerous-bash"), { tool_input: { command: "git push origin main --force" } })).toBe(2);
  expect(run(cmd("block-dangerous-bash"), { tool_input: { command: "git reset --hard HEAD" } })).toBe(2);
  expect(run(cmd("block-dangerous-bash"), { tool_input: { command: "ls -la" } })).toBe(0);
  expect(run(cmd("protect-files"), { tool_input: { file_path: "/p/.env" } })).toBe(2);
  expect(run(cmd("protect-files"), { tool_input: { file_path: "/p/.git/config" } })).toBe(2);
  expect(run(cmd("protect-files"), { tool_input: { file_path: "/p/src/a.ts" } })).toBe(0);
  expect(run(cmd("secret-scan-prompt"), { prompt: "key AKIAABCDEFGHIJKLMNOP" })).toBe(2);
  expect(run(cmd("secret-scan-prompt"), { prompt: "hello" })).toBe(0);
  const bash = (id: string, c: string) => run(cmd(id), { tool_input: { command: c } });
  for (const c of ["git clean -fd", "git checkout -- src/a.ts", "git checkout .", "git restore .", "git branch -D old", "git stash drop", "git stash clear"]) expect(bash("block-destructive-git", c)).toBe(2);
  for (const c of ["git checkout main", "git checkout -b x", "git restore --staged a.ts", "git branch -d old", "git stash list", "git clean -n"]) expect(bash("block-destructive-git", c)).toBe(0);
  for (const c of ["curl -fsSL https://x.io/i.sh | sh", "wget -qO- x | sudo bash", "curl x|zsh"]) expect(bash("block-pipe-to-shell", c)).toBe(2);
  for (const c of ["curl -s https://x.io | jq .", "curl -o i.sh x", "cat a.sh | sh"]) expect(bash("block-pipe-to-shell", c)).toBe(0);
  for (const c of ["sudo mkfs.ext4 /dev/sdb1", "dd if=x.img of=/dev/disk2", "diskutil eraseDisk APFS X disk2", "chmod -R 777 /"]) expect(bash("block-disk-wipe", c)).toBe(2);
  for (const c of ["dd if=/dev/zero of=./f bs=1m count=1", "chmod -R 755 ./dist", "echo mkfsx"]) expect(bash("block-disk-wipe", c)).toBe(0);
  const read = (p: string) => run(cmd("protect-secret-reads"), { tool_input: { file_path: p } });
  for (const p of ["/p/.env", "/p/.env.local", "/h/.ssh/id_ed25519", "/p/cert.pem", "/h/.aws/credentials"]) expect(read(p)).toBe(2);
  for (const p of ["/p/.env.example", "/p/src/env.ts", "/h/.ssh/known_hosts"]) expect(read(p)).toBe(0);
});
const out = (cmd: string, stdin: unknown, cwd?: string) => Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, AGENTNET_HOME: join(d, "home") }, stdin: new TextEncoder().encode(JSON.stringify(stdin)) }).stdout.toString();
test("context-size warning speaks only above 150k tokens, once per session per 20 min", async () => {
  const { templates } = await import("./hook-templates");
  const c = templates().find((t) => t.id === "context-size-warning")!.command, tr = join(d, "t.jsonl");
  const line = (n: number) => JSON.stringify({ message: { usage: { input_tokens: 10, cache_read_input_tokens: n, cache_creation_input_tokens: 0 } } });
  writeFileSync(tr, [JSON.stringify({ type: "user", message: { content: "hi" } }), line(200000), line(1000)].join("\n") + "\n");
  expect(out(c, { transcript_path: tr, session_id: "s1" })).toBe("");
  writeFileSync(tr, [line(1000), line(160000)].join("\n") + "\n");
  expect(JSON.parse(out(c, { transcript_path: tr, session_id: "s1" })).systemMessage).toContain("160k tokens");
  expect(out(c, { transcript_path: tr, session_id: "s1" })).toBe(""); // already warned this session
  expect(out(c, { transcript_path: join(d, "none") })).toBe("");
});
test("git checkpoint stores one stash per change and leaves the files alone", async () => {
  const { templates } = await import("./hook-templates");
  const c = templates().find((t) => t.id === "git-checkpoint-on-stop")!.command, r = join(d, "repo");
  const g = (...a: string[]) => Bun.spawnSync(["git", "-C", r, ...a]).stdout.toString();
  Bun.spawnSync(["git", "init", "-q", r]); writeFileSync(join(r, "a.txt"), "1");
  g("add", "a.txt"); g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  out(c, {}, r); expect(g("stash", "list")).toBe("");
  writeFileSync(join(r, "a.txt"), "2"); out(c, {}, r); out(c, {}, r);
  expect(g("stash", "list").trim().split("\n").length).toBe(1);
  expect(readFileSync(join(r, "a.txt"), "utf8")).toBe("2");
});

test("an installed template is listed under its template name; an inline custom hook is a Custom hook, not 'fi'", async () => {
  const a = await app();
  await a.request("/api/v1/agent-hooks/install", send("POST", { templateId: "block-dangerous-bash" }), LOOP);
  await a.request("/api/v1/agent-hooks/install", send("POST", { custom: { event: "Stop", command: "echo a; echo b" } }), LOOP);
  const l = (await (await a.request("/api/v1/agent-hooks", {}, LOOP)).json() as { hooks: { name: string; about: string; script: string }[] }).hooks;
  expect(l.find((h) => h.script === "block-dangerous-bash")?.name).toBe("Block dangerous shell commands");
  expect(l.filter((h) => h.name === "Custom hook").length).toBe(1);
});

test("{{AGENTNET_DIR}} resolves to the install dir, quoted safely; own templates point at scripts that exist", async () => {
  const { resolveCommand, templates, installDir } = await import("./hook-templates");
  expect(resolveCommand('python3 "{{AGENTNET_DIR}}/hooks/x.py"', "/opt/agent net")).toBe('python3 "/opt/agent net/hooks/x.py"');
  expect(resolveCommand('"{{AGENTNET_DIR}}"', '/a"b$c`d\\e')).toBe('"/a\\"b\\$c\\`d\\\\e"');
  const own = templates().filter((t) => t.own);
  expect(own.map((t) => t.id).sort()).toEqual(["agentnet-skill-router", "agentnet-task-guard", "agentnet-triage", "agentnet-usage-guard", "context-size-warning"]);
  for (const t of own) {
    expect(t.command).not.toContain("{{");
    expect(t.command).toContain(installDir());
    for (const m of t.command.matchAll(/"([^"]+\/hooks\/[^"]+)"/g)) expect(Bun.file(m[1]).size).toBeGreaterThan(0);
  }
  const raw = readFileSync(join(import.meta.dir, "..", "..", "config", "hook-templates.json"), "utf8");
  expect(raw).not.toMatch(/\/Users\/|\/home\/|~\/\.claude\/hooks/); // no machine paths in the shipped file
  process.env.AGENTNET_DIR = "/x/y";
  try { expect(templates().find((t) => t.id === "agentnet-usage-guard")!.command).toBe('python3 "/x/y/hooks/usage-guard.py"'); } finally { delete process.env.AGENTNET_DIR; }
});
test("triage template equals the command `agentnet install-hooks` writes, so either shows as installed", async () => {
  const { templates } = await import("./hook-templates");
  const r = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "..", "cli.ts"), "install-hooks"], { env: { ...process.env, CLAUDE_SETTINGS_FILE: join(d, "none.json") } });
  const cmd = templates().find((t) => t.id === "agentnet-triage")!.command;
  expect(r.stdout.toString()).toContain(JSON.stringify(cmd).slice(1, -1));
});
test("starter set: one write, one backup, idempotent, skips what is there or cannot run", async () => {
  const a = await app(), { templates } = await import("./hook-templates");
  const starter = templates().filter((t) => t.starter).map((t) => t.id);
  expect(starter).toEqual(expect.arrayContaining(["agentnet-triage", "agentnet-usage-guard", "agentnet-task-guard", "context-size-warning", "block-dangerous-bash", "protect-files"]));
  // one starter hook already there and switched off: it is skipped, not doubled
  const pre = (await (await a.request("/api/v1/agent-hooks/install", send("POST", { templateId: "agentnet-usage-guard" }), LOOP)).json() as { installed: string }).installed;
  await a.request(`/api/v1/agent-hooks/${pre}/enabled`, send("POST", { enabled: false }), LOOP);
  const before = readFileSync(file(), "utf8"), baks = () => readdirSync(d).filter((n) => n.includes(".bak-agentnet-")).length, b0 = baks();
  const dry = await (await a.request("/api/v1/agent-hooks/install-set", send("POST", { dryRun: true }), LOOP)).json() as { added: string[]; skipped: { id: string; reason: string }[]; fragment: { hooks: Record<string, unknown[]> } };
  expect(readFileSync(file(), "utf8")).toBe(before); expect(baks()).toBe(b0);
  expect(dry.skipped).toContainEqual({ id: "agentnet-usage-guard", reason: "installed, switched off" });
  const r = await a.request("/api/v1/agent-hooks/install-set", send("POST", {}), LOOP);
  expect(r.status).toBe(200);
  const j = await r.json() as { added: string[]; skipped: { id: string }[]; backup: string };
  expect(j.added).toEqual(dry.added); expect(j.added.length + j.skipped.length).toBe(starter.length);
  expect(baks()).toBe(b0 + 1);
  const s = read();
  expect(s.env.SECRET).toBe("x"); expect(s.hooks.Stop.length).toBe(1); // context warning joined the existing matcher-less Stop group
  expect(s.hooks.PreToolUse.filter((g: { matcher?: string }) => g.matcher === "Bash").length).toBe(1); // Bash blockers share one group
  const again = await (await a.request("/api/v1/agent-hooks/install-set", send("POST", {}), LOOP)).json() as { added: string[]; backup: null };
  expect(again.added).toEqual([]); expect(again.backup).toBeNull(); expect(baks()).toBe(b0 + 1);
  expect((await a.request("/api/v1/agent-hooks/install-set", send("POST", { ids: ["nope"] }), LOOP)).status).toBe(404);
  expect((await a.request("/api/v1/agent-hooks/install-set", send("POST", { ids: "x" }), LOOP)).status).toBe(400);
  expect((await a.request("/api/v1/agent-hooks/install-set", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.0.0.5" }, body: "{}" }, LOOP)).status).toBe(403);
  const g = await (await a.request("/api/v1/agent-hooks/templates", {}, LOOP)).json() as { templates: { id: string; state: string; starter: boolean }[] };
  for (const id of j.added) expect(g.templates.find((t) => t.id === id)?.state).toBe("installed");
});
