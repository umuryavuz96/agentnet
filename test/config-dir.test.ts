// Step 3: one Claude Code config dir per agent (agents/<name>/claude), used only with an account secret AND a complete base.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-cfg-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../src/core/db");
useDatabase(new Database(":memory:")); // before the modules below register their tables: a closed handle from an earlier file must not be used
const { tracing } = await import("../src/core/http");
type Env = import("../src/core/http").Env;
const { ROOT } = await import("../src/core/config");
const st = await import("../src/net/store");
const rt = await import("../src/net/routes");
const ac = await import("../src/net/accounts");
const cfg = await import("../src/net/agent-config");
const feed = await import("../src/net/feed");

const app = new Hono<Env>(); app.use("*", tracing); const api = new Hono<Env>(); rt.agentnetRoutes(api); app.route("/api/v1", api);
const tok: Record<string, string> = {};
const call = async (who: string, method: string, path: string, body?: unknown) => {
  const r = await app.request(`/api/v1/agentnet${path}`, { method, headers: { authorization: `Bearer ${tok[who] ?? who}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const base = cfg.baseDir();
const HOME0 = process.env.HOME, CH0 = process.env.AGENTNET_CLAUDE_HOME;
const FAKE_HOME = mkdtempSync(join(tmpdir(), "an-cfg-home-"));
const project = mkdtempSync(join(tmpdir(), "an-cfg-proj-"));
const SECRET = "sk-ant-oat01-CFGSECRET-" + "z".repeat(30);

beforeAll(() => {
  process.env.HOME = FAKE_HOME; process.env.AGENTNET_CLAUDE_HOME = join(FAKE_HOME, ".claude");
  st._reset();
  tok.root = rt.createAgent({ name: "root", job: "t", by: "test", standing: true }).token;
  rmSync(base, { recursive: true, force: true }); rmSync(join(ROOT, "accounts"), { recursive: true, force: true });
  mkdirSync(join(base, "rules"), { recursive: true }); mkdirSync(join(base, "skills", "s1"), { recursive: true });
  writeFileSync(join(base, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo base-hook" }] }] }, permissions: { deny: ["Read(./.env)"] } }));
  writeFileSync(join(base, "CLAUDE.md"), "# base rules\n"); writeFileSync(join(base, "rules", "a.md"), "rule a\n"); writeFileSync(join(base, "skills", "s1", "SKILL.md"), "s\n");
  writeFileSync(join(base, "mcp.json"), JSON.stringify({ mcpServers: { pigeon: { command: "pigeon-mcp" }, notes: { type: "http", url: "http://127.0.0.1:1/mcp" } } }));
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { playwright: { command: "pw" }, heavy: { command: "heavy" } } }));
});
afterAll(() => { rmSync(join(base, ".complete"), { force: true }); rmSync(join(ROOT, "accounts"), { recursive: true, force: true }); process.env.HOME = HOME0; if (CH0 === undefined) delete process.env.AGENTNET_CLAUDE_HOME; else process.env.AGENTNET_CLAUDE_HOME = CH0; });

const snapshot = (d: string, out = new Map<string, string>()): Map<string, string> => {
  for (const n of readdirSync(d)) { const p = join(d, n), s = statSync(p); if (s.isDirectory()) snapshot(p, out); else out.set(p, `${s.size} ${createHash("sha256").update(readFileSync(p)).digest("hex")} ${s.mtimeMs}`); }
  return out;
};

test("fallback: an account with an incomplete base (Hooks page settings.json only) keeps ~/.claude", async () => {
  ac.addAccount("main", { token: SECRET });
  expect(cfg.baseComplete()).toBe(false); // base/settings.json exists, .complete does not
  expect(cfg.usesOwnDir({ account: "main" })).toBe(false);
  const a = rt.createAgent({ name: "fb-1", boss: "root", job: "t", goal: "g", by: "test" });
  expect(cfg.configDirOf("fb-1")).toBe(join(FAKE_HOME, ".claude"));
  const r = await call("root", "POST", "/agents/fb-1/prepare-config", { project });
  expect(r.body).toEqual({ own: false, dir: null });
  expect(existsSync(cfg.agentConfigDir("fb-1"))).toBe(false);
  rt.retireAgent(rt.byName("fb-1")!, "despawn", Date.now(), () => {}); void a;
});

test("prepare: settings from base + deny rules (own token too), trust, only the asked MCP, every base server, links into the base", async () => {
  writeFileSync(join(base, ".complete"), "");
  const before = snapshot(FAKE_HOME);
  const made = rt.createAgent({ name: "cfg-1", boss: "root", job: "t", goal: "g", by: "test", project });
  expect(cfg.usesOwnDir(rt.byName("cfg-1"))).toBe(true);
  const r = await call("root", "POST", "/agents/cfg-1/prepare-config", { project, mcp: "playwright" });
  expect(r.status).toBe(200);
  const dir = cfg.agentConfigDir("cfg-1");
  expect(r.body).toMatchObject({ own: true, dir, env: "CLAUDE_CODE_OAUTH_TOKEN", file: join(ROOT, "accounts", "main", "oauth-token") });
  expect(JSON.stringify(r.body)).not.toContain("CFGSECRET");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(s.hooks.Stop[0].hooks[0].command).toBe("echo base-hook");
  expect(s.env.DISABLE_AUTOUPDATER).toBe("1");
  const deny: string[] = s.permissions.deny;
  expect(deny).toContain("Read(./.env)"); // the base's own rules stay
  for (const rel of ["run/**", "accounts/**", "agents/*/token"]) for (const v of ["Read", "Edit"]) expect(deny).toContain(`${v}(/${join(ROOT, rel)})`);
  expect(made.tokenFile).toBe(join(ROOT, "agents", made.id.split("#")[0]!, "token")); // the own token sits at agents/<name>/token: denied to its tools by agents/*/token (the plugin reads it in-process)
  const c = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
  const proj = c.projects[project] ?? c.projects[realpathSync(project)];
  expect(proj.hasTrustDialogAccepted).toBe(true);
  expect(proj.enabledMcpjsonServers).toEqual(["playwright"]); expect(proj.disabledMcpjsonServers).toEqual(["heavy"]);
  expect(Object.keys(c.mcpServers).sort()).toEqual(["notes", "pigeon"]);
  expect(c.autoUpdates).toBe(false);
  expect(realpathSync(join(dir, "CLAUDE.md"))).toBe(realpathSync(join(base, "CLAUDE.md")));
  expect(realpathSync(join(dir, "rules", "a.md"))).toBe(realpathSync(join(base, "rules", "a.md")));
  expect(realpathSync(join(dir, "skills"))).toBe(realpathSync(join(base, "skills")));
  expect(existsSync(join(dir, "agents"))).toBe(false); expect(existsSync(join(dir, "plugins"))).toBe(false); // no base agents/: no link; plugins never
  expect(snapshot(FAKE_HOME)).toEqual(before); // the user's home is not touched when the agent has its own dir
});

test("prepare again keeps what Claude Code wrote", async () => {
  const dir = cfg.agentConfigDir("cfg-1");
  mkdirSync(join(dir, "projects", "x"), { recursive: true }); writeFileSync(join(dir, "projects", "x", "s.jsonl"), "{}\n");
  const c = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")); c.numStartups = 7; c.oauthAccount = { emailAddress: "kept@example.invalid" }; c.mcpServers.mine = { command: "mine" };
  writeFileSync(join(dir, ".claude.json"), JSON.stringify(c));
  const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")); s.model = "opus"; writeFileSync(join(dir, "settings.json"), JSON.stringify(s));
  expect((await call("root", "POST", "/agents/cfg-1/prepare-config", { project, mcp: "playwright" })).status).toBe(200);
  expect(readFileSync(join(dir, "projects", "x", "s.jsonl"), "utf8")).toBe("{}\n");
  const c2 = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
  expect(c2).toMatchObject({ numStartups: 7, oauthAccount: { emailAddress: "kept@example.invalid" } });
  expect(Object.keys(c2.mcpServers).sort()).toEqual(["mine", "notes", "pigeon"]);
  const s2 = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(s2.model).toBe("opus"); expect(new Set(s2.permissions.deny).size).toBe(s2.permissions.deny.length); // merged once, no duplicates
});

test("sandbox: prepare adds no sandbox key (read denies only are not possible), the token deny rules stay", async () => {
  expect((await call("root", "POST", "/agents/cfg-1/prepare-config", { project, mcp: "playwright" })).status).toBe(200);
  const s = JSON.parse(readFileSync(join(cfg.agentConfigDir("cfg-1"), "settings.json"), "utf8"));
  expect(s.sandbox).toBeUndefined();
  for (const rel of ["run/**", "accounts/**", "agents/*/token"]) expect(s.permissions.deny).toContain(`Read(/${join(ROOT, rel)})`);
});

test("readers: the agent's transcript is found in its own dir; an agent without an account uses ~/.claude", () => {
  const dir = cfg.agentConfigDir("cfg-1"), slug = project.replace(/[^a-zA-Z0-9]/g, "-");
  mkdirSync(join(dir, "projects", slug), { recursive: true }); writeFileSync(join(dir, "projects", slug, "s.jsonl"), "{}\n");
  expect(cfg.configDirOf("cfg-1")).toBe(dir);
  expect(feed.projectDir(project, "cfg-1")).toBe(join(dir, "projects", slug));
  expect(feed.transcriptFor({ session: "s", project, pid: null, name: "cfg-1" })).toBe(join(dir, "projects", slug, "s.jsonl"));
  expect(cfg.allProjectDirs()).toContain(join(dir, "projects"));
  rt.createAgent({ name: "other-1", boss: "root", job: "t", goal: "g", by: "test", project, account: "nobody" }); // no secret for this account
  expect(cfg.configDirOf("other-1")).toBe(join(FAKE_HOME, ".claude"));
  expect(feed.projectDir(project, "other-1")).toBe(join(FAKE_HOME, ".claude", "projects", slug));
  expect(feed.projectDir(project)).toBe(join(FAKE_HOME, ".claude", "projects", slug)); // the old signature
  expect(cfg.configDirOf(null)).toBe(join(FAKE_HOME, ".claude"));
});

test("spawn route: account is stored and own_config says which flow the boot script takes", async () => {
  const r = await call("root", "POST", "/spawn", { name: "sp-1", job: "j", goal: "spawn route check", project, project_default: false });
  expect(r.status).toBe(201); expect(r.body).toMatchObject({ account: "main", own_config: true });
  expect(rt.byName("sp-1")!.account).toBe("main");
  const n = await call("root", "POST", "/spawn", { name: "sp-2", job: "j", goal: "spawn route check", project, project_default: false, account: "nobody" });
  expect(n.body).toMatchObject({ account: "nobody", own_config: false });
  expect((await call("root", "POST", "/spawn", { name: "sp-3", job: "j", goal: "spawn route check", project, account: "Bad Id" })).status).toBe(422);
  tok["sp-1"] = readFileSync(r.body.token_file, "utf8").trim();
  expect((await call("sp-1", "POST", "/agents/sp-1/prepare-config", { project })).status).toBe(403); // agents cannot prepare a config dir
});
