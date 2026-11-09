// agentnet CLI. No dependencies; arguments are parsed by hand. Run `agentnet help` for the commands.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { serviceLabel, serviceUnit } from "./update/service";

const HOME = homedir();
const ROOT = process.env.AGENTNET_HOME ?? join(HOME, ".local", "share", "agentnet");
const PORT = Number(process.env.AGENTNET_PORT ?? 3096), HOST = process.env.AGENTNET_HOST ?? "127.0.0.1";
const REPO = resolve(import.meta.dir, "..");

const HELP = `agentnet: a local network for Claude Code agents
  help | version | home | url | plugin-dir
  serve                     run the server in the foreground
  spawn | join | pick-model | pick-soul | bg   run the matching script (see scripts/)
  council <project> <team> "<job>" "<name=angle,...>" "<roles>" [--go] [--ask T]   plan a council team (spawn it with --go)
  install-hooks [--write]   print the triage hook snippet for ~/.claude/settings.json; --write merges it (backup first)
  plan-spawn --job TEXT [--project DIR] [--role R] ...   where a new agent would land (name, boss, team, model, soul); changes nothing
  despawn <name> [--reason R]
  status                    health and agent list of the running server
  init [dir] [--start]      first run: check the setup, print the command that starts the director; --start runs it in tmux
  doctor                    check bun, tmux, claude, python3, data folder, service
  install-service [--dry-run]   write a launchd (macOS) or systemd user unit; never starts it
  migrate-from-server-os --source <var> [--to <home>] [--dry-run] [--members a,b]   copy a Server OS var folder into an agentnet home
  export-legacy --to <server-os var> [--from <home>] [--yes]   copy post-cutover data back (rollback); dry run without --yes
  update [--check] [--yes]  move to the newest release tag (install, build, restart, doctor; rolls back on failure)`;

/** Read $ROOT/config/env (KEY=VALUE lines); a key already in the environment wins. */
function loadEnvFile(): void {
  const f = join(ROOT, "config", "env");
  if (!existsSync(f)) return;
  for (const raw of readFileSync(f, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith("~/")) v = HOME + v.slice(1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const url = () => process.env.AGENTNET_URL ?? `http://127.0.0.1:${PORT}/api/v1/agentnet`;
const pluginDir = () => join(REPO, "plugin");
const version = (): string => JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;

async function runScript(script: string, args: string[]): Promise<never> {
  const env: Record<string, string | undefined> = { ...process.env };
  const defaults = { AGENTNET_HOME: ROOT, AGENTNET_URL: url(), AGENTNET_MOD_DIR: pluginDir(), AGENTNET_BIN: join(REPO, "bin", "agentnet") };
  for (const [k, v] of Object.entries(defaults)) if (env[k] === undefined) env[k] = v;
  const proc = Bun.spawn([join(REPO, "scripts", script), ...args], { stdio: ["inherit", "inherit", "inherit"], env });
  process.exit(await proc.exited);
}

async function getJson(u: string, ms: number): Promise<any | null> {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function despawn(args: string[]): Promise<number> {
  const name = args[0];
  if (!name) { console.error("usage: agentnet despawn <name> [--reason R]"); return 2; }
  const ri = args.indexOf("--reason");
  const reason = ri >= 0 ? args[ri + 1] : undefined;
  try {
    const r = await fetch(`${url()}/despawn`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: name, reason: reason ?? "cli" }), signal: AbortSignal.timeout(5000),
    });
    console.log(await r.text());
    return r.ok ? 0 : 1;
  } catch (e) { console.error(`agentnet: despawn failed: ${(e as Error).message}`); return 1; }
}

async function planSpawn(args: string[]): Promise<number> {
  const body: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, ""), v = args[i + 1];
    if (!k || v === undefined || !["job", "project", "role", "name", "boss", "team", "model", "effort", "soul", "scope", "novelty", "risk", "need", "ask", "goal"].includes(k)) { console.error("usage: agentnet plan-spawn --job TEXT [--project DIR] [--role R] [--name N] [--boss B] [--team ID] [--model M] [--effort E] [--soul S] [--scope 1-5] [--novelty 1-3] [--risk 0-3] [--need WORDS] [--ask TEXT]"); return 2; }
    body[k] = ["scope", "novelty", "risk"].includes(k) ? Number(v) : k === "project" ? resolve(tilde(v)) : v;
  }
  try {
    const r = await fetch(`${url()}/plan-spawn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    console.log(JSON.stringify(await r.json(), null, 2));
    return r.ok ? 0 : 1;
  } catch (e) { console.error(`agentnet: plan-spawn failed: ${(e as Error).message}`); return 1; }
}

async function status(): Promise<number> {
  const origin = new URL(url()).origin;
  const h = await getJson(`${origin}/v1/health`, 3000);
  if (!h) { console.log(`agentnet is not running at ${origin}`); return 1; }
  console.log(`agentnet ${h.version} api ${h.api} at ${origin}`);
  const a = await getJson(`${url()}/agents`, 3000);
  for (const x of a?.agents ?? []) console.log(`${x.name}  ${x.life}  ${x.state}  ${x.doing ?? ""}`);
  return 0;
}

async function doctor(): Promise<number> {
  const { doctorLines, formatDoctorLine } = await import("./update/doctor");
  const lines = await doctorLines({ root: ROOT, host: HOST, port: PORT });
  for (const l of lines) console.log(formatDoctorLine(l));
  return lines.some((l) => l.level === "FAIL") ? 1 : 0;
}

/** First run in one command: checks, then the command that starts Claude Code as the director (or starts it with --start). */
async function init(args: string[]): Promise<number> {
  const start = args.includes("--start");
  const { doctorLines, formatDoctorLine } = await import("./update/doctor");
  const { checkDir, directorCommand, startDirector } = await import("./net/director");
  const lines = await doctorLines({ root: ROOT, host: HOST, port: PORT });
  console.log("1. Check your setup");
  for (const l of lines) console.log("   " + formatDoctorLine(l));
  const svc = lines.find((l) => l.check === "service");
  const fails = lines.filter((l) => l.level === "FAIL");
  if (fails.length) { console.log(`\nFix ${fails.map((l) => l.check).join(", ")} first, then run agentnet init again.`); return 1; }
  const d = checkDir(args.find((a) => !a.startsWith("-")) ?? process.cwd());
  if ("error" in d) { console.error("agentnet: " + d.error); return 2; }
  const origin = new URL(url()).origin;
  console.log("\n2. Start the server");
  if (svc?.level !== "ok") { console.log(`   Not running. In another terminal run: ${join(REPO, "bin", "agentnet")} serve   (or install-service to keep it on)`); }
  else console.log(`   Running at ${origin}`);
  const agents = svc?.level === "ok" ? await getJson(`${url()}/agents`, 3000) : null;
  const hasRoot = (agents?.agents ?? []).some((x: { name: string; life?: string }) => x.name === "root" && x.life !== "gone");
  console.log("\n3. Start the director in " + d.dir);
  if (hasRoot) { console.log(`   A director is already connected. Open ${origin}`); return 0; }
  if (start) {
    const r = startDirector(d.dir);
    if (!r.ok) { console.log(`   ${r.detail}\n   Or run it yourself:\n   ${directorCommand(d.dir)}`); return 1; }
    console.log(`   Started in tmux session ${r.session}. The first time Claude Code asks to trust the folder: ${r.attach}, answer Yes, then Ctrl-b d.`);
  } else console.log(`   Run this in a terminal (or add --start to run it in tmux):\n\n   ${directorCommand(d.dir)}\n`);
  console.log(`\n4. Open the board: ${origin}   (the setup card turns green when the director says hello)`);
  return 0;
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
/** systemd: inside double quotes escape \\, " and %; elsewhere (path directives, no quoting) escape only %. */
const sdQuoted = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
const sdPlain = (s: string) => s.replace(/%/g, "%%");

type Esc = (s: string, quoted: boolean) => string;
function render(tmpl: string, vals: Record<string, string>, esc: Esc): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string, off: number) => {
    if (!(k in vals)) throw new Error(`unknown placeholder {{${k}}}`);
    const lineStart = tmpl.lastIndexOf("\n", off) + 1;
    const quoted = (tmpl.slice(lineStart, off).match(/"/g) ?? []).length % 2 === 1;
    return esc(vals[k]!, quoted);
  });
}

function installService(args: string[]): number {
  const dry = args.includes("--dry-run");
  const logDir = join(ROOT, "logs");
  let label: string, unitName: string;
  try { label = serviceLabel(); unitName = serviceUnit(); } catch (e) { console.error(`agentnet: install-service: ${(e as Error).message}`); return 1; }
  const vals = { Label: label, Unit: unitName, Bun: process.execPath, SourceDir: REPO, Home: ROOT, Port: String(PORT), Host: HOST, Path: process.env.PATH ?? "", LogDir: logDir };
  let target: string, tmplPath: string, esc: Esc, next: string;
  if (process.platform === "darwin") {
    target = join(HOME, "Library", "LaunchAgents", `${label}.plist`);
    tmplPath = join(REPO, "install", "launchd", "dev.agentnet.server.plist.tmpl"); esc = (v) => xmlEsc(v);
    next = `launchctl bootstrap gui/$(id -u) ${target}`;
  } else if (process.platform === "linux") {
    target = join(HOME, ".config", "systemd", "user", `${unitName}.service`);
    tmplPath = join(REPO, "install", "systemd", "agentnet.service.tmpl"); esc = (v, q) => (q ? sdQuoted(v) : sdPlain(v));
    next = `systemctl --user daemon-reload && systemctl --user enable --now ${unitName}`;
  } else { console.error("agentnet: install-service supports macOS and Linux"); return 1; }
  let text: string;
  try { text = render(readFileSync(tmplPath, "utf8"), vals, esc); }
  catch (e) { console.error(`agentnet: install-service: ${(e as Error).message}`); return 1; }
  if (dry) { process.stdout.write(text); console.error(`would write ${target}`); return 0; }
  if (existsSync(target)) { console.log(`exists, not overwritten: ${target}`); return 0; }
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(target, text);
  console.log(`wrote ${target}\nnext: ${next}`);
  return 0;
}

/** The settings.json "hooks" entry that runs hooks/triage.py on every prompt. */
export function triageSnippet(): { hooks: { UserPromptSubmit: { hooks: { type: string; command: string; timeout: number }[] }[] } } {
  const command = `AGENTNET_BIN=${JSON.stringify(join(REPO, "bin", "agentnet"))} python3 ${JSON.stringify(join(REPO, "hooks", "triage.py"))}`;
  return { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 6 }] }] } };
}

/** Print the snippet; with --write, back up settings.json (CLAUDE_SETTINGS_FILE or ~/.claude/settings.json), then add the hook once. */
function installHooks(args: string[]): number {
  const snip = triageSnippet();
  if (!args.includes("--write")) {
    console.log(JSON.stringify(snip, null, 2));
    console.error("add the hooks key to ~/.claude/settings.json, or run: agentnet install-hooks --write");
    return 0;
  }
  const file = process.env.CLAUDE_SETTINGS_FILE ?? join(HOME, ".claude", "settings.json");
  let cur: Record<string, any> = {};
  if (existsSync(file)) {
    try { cur = JSON.parse(readFileSync(file, "utf8")); } catch { console.error(`agentnet: ${file} is not valid JSON; not touched`); return 1; }
    if (((cur.hooks ?? {}).UserPromptSubmit ?? []).some((g: any) => (g?.hooks ?? []).some((h: any) => String(h?.command ?? "").includes("triage.py")))) { console.log("triage hook already installed"); return 0; }
    const bak = `${file}.bak-agentnet-${Date.now()}`;
    copyFileSync(file, bak);
    console.log(`backup ${bak}`);
  }
  const group = snip.hooks.UserPromptSubmit[0]!;
  const list: any[] = ((cur.hooks ??= {}).UserPromptSubmit ??= []);
  list.push(group);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-agentnet`;
  writeFileSync(tmp, JSON.stringify(cur, null, 2) + "\n");
  renameSync(tmp, file);
  console.log(`added the triage hook to ${file}`);
  return 0;
}

const flag = (a: string[], n: string): string | undefined => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const tilde = (p: string) => (p.startsWith("~/") ? HOME + p.slice(1) : p);

/** True when an agentnet service answers on HOST:PORT (a real migration or rollback must not run under it). */
async function serviceUp(): Promise<boolean> {
  try { return (await fetch(`http://${HOST}:${PORT}/v1/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}

async function migrateCmd(args: string[]): Promise<number> {
  const source = flag(args, "--source");
  if (!source) { console.error("usage: agentnet migrate-from-server-os --source <var> [--to <home>] [--dry-run] [--members a,b,c]"); return 2; }
  const dryRun = args.includes("--dry-run");
  const members = (flag(args, "--members") ?? "root").split(",").map((s) => s.trim()).filter(Boolean);
  if (!members.length || members.some((m) => !/^[a-z0-9-]+$/.test(m))) { console.error("agentnet: --members: names must match ^[a-z0-9-]+$"); return 2; }
  const toArg = flag(args, "--to");
  const to = toArg ? tilde(toArg) : dryRun ? mkdtempSync(join(tmpdir(), "an-rehearsal-")) : ROOT;
  if (!dryRun && (await serviceUp())) { console.log(`agentnet is running on ${HOST}:${PORT}: stop it before a real migration`); return 1; }
  try {
    const { migrate } = await import("./migrate/fromServerOs");
    const r = migrate({ source: resolve(tilde(source)), to: resolve(to), dryRun, members });
    for (const [t, c] of Object.entries(r.counts)) console.log(`table ${t}  source ${c.source}  target ${c.target}  ${c.source === c.target ? "ok" : "DIFF"}`);
    console.log(`fold ${r.fold.agents} agents, ${r.fold.differ.length} differ`);
    for (const id of r.fold.differ) console.log(`  differ ${id}`);
    console.log(`marks ${join(resolve(to), "data", "migrated-from.json")}`);
    for (const s of r.skipped) console.log(`skip ${s}`);
    if (dryRun && r.ok) console.log(`next: AGENTNET_HOME=${resolve(to)} AGENTNET_PORT=3196 AGENTNET_SWEEP=0 agentnet serve`);
    console.log(r.ok ? (dryRun ? `migrate ok (dry run in ${resolve(to)})` : "migrate ok") : "migrate FAILED");
    return r.ok ? 0 : 1;
  } catch (e) { console.error((e as Error).message); return 1; }
}

async function exportCmd(args: string[]): Promise<number> {
  const toArg = flag(args, "--to");
  if (!toArg) { console.error("usage: agentnet export-legacy --to <server-os var> [--from <home>] [--yes]"); return 2; }
  const yes = args.includes("--yes");
  if (yes && (await serviceUp())) { console.log(`agentnet is running on ${HOST}:${PORT}: stop it before a rollback`); return 1; }
  try {
    const { exportLegacy } = await import("./migrate/exportLegacy");
    const r = exportLegacy({ from: resolve(tilde(flag(args, "--from") ?? ROOT)), to: resolve(tilde(toArg)), yes });
    for (const [t, n] of Object.entries(r.written)) console.log(`table ${t}  rows ${n}`);
    for (const f of r.trails) console.log(`trail ${f}`);
    if (r.dryRun) console.log("dry run: add --yes to write (stop Server OS and agentnet first)");
    return 0;
  } catch (e) { console.error((e as Error).message); return 1; }
}

async function main(): Promise<number> {
  loadEnvFile();
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined: case "help": case "--help": case "-h": console.log(HELP); return 0;
    case "version": console.log(version()); return 0;
    case "home": console.log(ROOT); return 0;
    case "url": console.log(url()); return 0;
    case "plugin-dir": console.log(pluginDir()); return 0;
    case "serve": {
      const p = Bun.spawn([process.execPath, "run", join(REPO, "src/server.ts")], { stdio: ["inherit", "inherit", "inherit"] });
      return await p.exited;
    }
    case "spawn": return runScript("spawn-agent.sh", rest);
    case "join": return runScript("agentnet-join.sh", rest);
    case "pick-model": return runScript("pick-model.sh", rest);
    case "pick-soul": return runScript("pick-soul.sh", rest);
    case "bg": return runScript("bgjob.sh", rest);
    case "council": return runScript("council.sh", rest);
    case "install-hooks": return installHooks(rest);
    case "plan-spawn": return planSpawn(rest);
    case "despawn": return despawn(rest);
    case "status": return status();
    case "init": return init(rest);
    case "doctor": return doctor();
    case "install-service": return installService(rest);
    case "migrate-from-server-os": return migrateCmd(rest);
    case "export-legacy": return exportCmd(rest);
    case "update": return (await import("./update/cli")).runUpdateCli(rest, { repo: REPO, home: ROOT });
    default: console.error(`agentnet: unknown command '${cmd}'\n${HELP}`); return 2;
  }
}

process.exit(await main());
