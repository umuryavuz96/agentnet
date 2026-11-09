// How agentnet runs (launchd, systemd, foreground), how to restart it, how to wait for it.
// A service manager counts only when its unit belongs to THIS checkout and THIS port: an update run from another
// clone, or against another port, must never restart the live service.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Mode = "launchd" | "systemd" | "foreground" | "unknown";
/** Default names `agentnet install-service` writes. */
export const LAUNCHD_LABEL = "dev.agentnet.server";
export const SYSTEMD_UNIT = "agentnet";

const NAME = /^[A-Za-z0-9._-]+$/;
const named = (v: string | undefined, def: string, what: string): string => {
  const x = v?.trim();
  if (!x) return def;
  if (!NAME.test(x)) throw new Error(`${what} may only contain letters, digits, dot, underscore and dash`);
  return x;
};
/** The launchd label: AGENTNET_SERVICE_LABEL, else the default. Lets a second install (or a test) run beside the real one. */
export const serviceLabel = (env: NodeJS.ProcessEnv = process.env): string => named(env.AGENTNET_SERVICE_LABEL, LAUNCHD_LABEL, "AGENTNET_SERVICE_LABEL");
/** The systemd user unit name (without .service): AGENTNET_SERVICE_UNIT, else the default. */
export const serviceUnit = (env: NodeJS.ProcessEnv = process.env): string => named(env.AGENTNET_SERVICE_UNIT, SYSTEMD_UNIT, "AGENTNET_SERVICE_UNIT");

export interface ServiceCtx { repo: string; host: string; port: number; /** user home, for unit files; tests only */ home?: string }
export interface ServiceApi {
  detectMode(serverPid?: number): Promise<Mode>;
  restart(mode: Mode): Promise<void>;
  waitHealth(version: string, ms: number): Promise<boolean>;
}
export type Sh = (cmd: string[]) => { code: number; out: string };

export const sh: Sh = (cmd) => {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    return { code: p.exitCode ?? 1, out: p.stdout.toString().trim() };
  } catch { return { code: 127, out: "" }; } // binary missing
};
const uid = () => process.getuid?.() ?? 501;

/** The pid that listens on the port, if lsof can tell. */
export function listenerPid(port: number, run: Sh = sh): number | undefined {
  const n = Number(run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).out.split("\n")[0]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

async function healthy(c: ServiceCtx): Promise<boolean> {
  try { return ((await (await fetch(`http://${c.host}:${c.port}/v1/health`, { signal: AbortSignal.timeout(2000) })).json()) as { name?: string }).name === "agentnet"; } catch { return false; }
}

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const same = (a: string, b: string) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };

/** Working directory and port written in the unit file at `file`, or null when it cannot be read. */
export function unitInfo(mode: "launchd" | "systemd", file: string): { dir: string | null; port: number } | null {
  try {
    const t = readFileSync(file, "utf8");
    if (mode === "launchd") {
      const dir = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(t)?.[1];
      const port = /<key>AGENTNET_PORT<\/key>\s*<string>(\d+)<\/string>/.exec(t)?.[1];
      return { dir: dir ? unesc(dir) : null, port: port ? Number(port) : 3096 };
    }
    const dir = /^WorkingDirectory=(.+)$/m.exec(t)?.[1]?.trim().replace(/^"|"$/g, "");
    const port = /AGENTNET_PORT=(\d+)/.exec(t)?.[1];
    return { dir: dir ?? null, port: port ? Number(port) : 3096 };
  } catch { return null; }
}

/** launchd/systemd only when the unit is loaded, belongs to this repo and this port (and owns the server pid, when known).
 *  The unit file is the one the manager reports for the loaded unit (`path = ` of launchctl print, FragmentPath of
 *  systemctl show), else the default location, so a unit installed anywhere still counts, and only for this repo and port. */
export async function detectMode(c: ServiceCtx, serverPid?: number, run: Sh = sh): Promise<Mode> {
  const home = c.home ?? homedir();
  const mine = (m: "launchd" | "systemd", file: string) => { const u = unitInfo(m, file); return !!u?.dir && same(u.dir, c.repo) && u.port === c.port; };
  try {
    if (process.platform === "darwin") {
      const label = serviceLabel(), r = run(["launchctl", "print", `gui/${uid()}/${label}`]);
      if (r.code === 0) {
        const file = /^\s*path = (.+)$/m.exec(r.out)?.[1]?.trim() ?? join(home, "Library", "LaunchAgents", `${label}.plist`);
        const pid = /\bpid = (\d+)/.exec(r.out)?.[1];
        if (mine("launchd", file) && (serverPid === undefined || (pid && Number(pid) === serverPid))) return "launchd";
      }
    } else if (process.platform === "linux") {
      const name = serviceUnit();
      if (run(["systemctl", "--user", "is-active", name]).out === "active") {
        const file = run(["systemctl", "--user", "show", "-p", "FragmentPath", "--value", name]).out || join(home, ".config", "systemd", "user", `${name}.service`);
        if (mine("systemd", file) && (serverPid === undefined || Number(run(["systemctl", "--user", "show", "-p", "MainPID", "--value", name]).out) === serverPid)) return "systemd";
      }
    }
  } catch { /* a bad AGENTNET_SERVICE_LABEL or _UNIT: not a service we can name */ }
  return (await healthy(c)) ? "foreground" : "unknown";
}

export async function restart(mode: Mode, run: Sh = sh): Promise<void> {
  const r = mode === "launchd" ? run(["launchctl", "kickstart", "-k", `gui/${uid()}/${serviceLabel()}`])
    : mode === "systemd" ? run(["systemctl", "--user", "restart", serviceUnit()]) : null;
  if (!r) throw new Error(`cannot restart in ${mode} mode`);
  if (r.code !== 0) throw new Error(`restart failed (${mode}): ${r.out.split("\n")[0] ?? ""}`);
}

/** Poll /v1/health every intervalMs until it reports `version`. */
export async function waitHealth(c: ServiceCtx, version: string, ms: number, intervalMs = 1000): Promise<boolean> {
  const end = Date.now() + ms;
  do {
    try {
      const h = (await (await fetch(`http://${c.host}:${c.port}/v1/health`, { signal: AbortSignal.timeout(2000) })).json()) as { name?: string; version?: string };
      if (h.name === "agentnet" && h.version === version) return true;
    } catch { /* not up yet */ }
    await Bun.sleep(intervalMs);
  } while (Date.now() < end);
  return false;
}

export function manualRestart(mode: Mode): string {
  return mode === "launchd" ? `launchctl kickstart -k gui/${uid()}/${serviceLabel()}`
    : mode === "systemd" ? `systemctl --user restart ${serviceUnit()}` : "restart agentnet yourself (stop it and run agentnet serve)";
}

export function makeService(c: ServiceCtx): ServiceApi {
  return {
    detectMode: (pid) => detectMode(c, pid ?? listenerPid(c.port)),
    restart: (m) => restart(m),
    waitHealth: (v, ms) => waitHealth(c, v, ms),
  };
}
