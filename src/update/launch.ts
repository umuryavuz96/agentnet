// How this server was started, so a detached updater can start it again when no service manager owns it.
// Written at server start to <home>/run/server-launch.json. Only AGENTNET_* and PATH are kept from the environment.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Launch { pid: number; execPath: string; argv: string[]; cwd: string; env: Record<string, string>; version: string; startedAt: number }

export const launchFile = (home: string) => join(home, "run", "server-launch.json");

export function launchEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (k.startsWith("AGENTNET_") || k === "PATH")) out[k] = v;
  return out;
}

export function recordLaunch(home: string, o: { version: string; pid?: number; execPath?: string; argv?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; now?: number }): Launch {
  const l: Launch = { pid: o.pid ?? process.pid, execPath: o.execPath ?? process.execPath, argv: o.argv ?? process.argv, cwd: o.cwd ?? process.cwd(), env: launchEnv(o.env ?? process.env), version: o.version, startedAt: o.now ?? Date.now() };
  mkdirSync(join(home, "run"), { recursive: true });
  const f = launchFile(home), t = `${f}.tmp`;
  writeFileSync(t, JSON.stringify(l, null, 2) + "\n", { mode: 0o600 });
  chmodSync(t, 0o600); // the env may hold a token
  renameSync(t, f);
  return l;
}

export function readLaunch(home: string): Launch | null {
  try {
    const l = JSON.parse(readFileSync(launchFile(home), "utf8")) as Partial<Launch>;
    if (!Number.isInteger(l.pid) || typeof l.execPath !== "string" || !Array.isArray(l.argv) || l.argv.length < 2 || !l.argv.every((a) => typeof a === "string") || typeof l.cwd !== "string" || !l.env || typeof l.env !== "object") return null;
    return l as Launch;
  } catch { return null; }
}

/** What to run to start the server again: the recorded executable and script, in the recorded folder. */
export function startPlan(l: Launch, base: NodeJS.ProcessEnv = process.env) {
  return { cmd: l.execPath, args: l.argv.slice(1), cwd: l.cwd, env: { ...base, ...l.env } as NodeJS.ProcessEnv };
}
