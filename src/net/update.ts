// Web side of `agentnet update`: status, a manual check, a run button, a progress stream, and the optional auto update.
// agentnet has no login, so the run route is root only (this machine or the root agent), moves only to the release the
// check reported, and starts a fixed command line. No ref, path or command from the request body reaches git or a shell.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { rootOnly } from "../core/access";
import { HOST, PORT, ROOT, VERSION } from "../core/config";
import { problem, type Env } from "../core/http";
import { logEvent } from "../core/logger";
import { check, checkEnabled, readCache, type CheckCache } from "../update/check";
import { readLaunch } from "../update/launch";
import { readLock } from "../update/lock";
import { preflight, type RefuseCode } from "../update/preflight";
import type { JobResult } from "../update/run";
import { detectMode, listenerPid, type Mode } from "../update/service";
import { cmp, fromPackage, parseTag } from "../update/version";
import { live } from "./store";

export const REPO = join(import.meta.dir, "..", "..");

export interface UpdateDeps {
  repo?: string; home?: string;
  /** Start the detached updater. Tests replace it; nothing spawns for real there. */
  spawnUpdater?: (argv: string[], mode: Mode, id: string) => void;
  mode?: () => Promise<Mode>;
  checkFn?: (force: boolean) => Promise<CheckCache>;
  allowLocalOrigin?: boolean;
  now?: () => number;
  /** Tests: does the launch record describe this server? */
  launchOk?: () => boolean;
}

const refuse = (c: Context, status: 400 | 403 | 409 | 500, code: string, detail: string) =>
  c.body(JSON.stringify({ type: "about:blank", title: code, status, code, detail, trace_id: c.get("trace")?.trace_id }), status, { "Content-Type": "application/problem+json" });

const webEnabled = () => process.env.AGENTNET_WEB_UPDATE !== "0";
export const autoOn = () => process.env.AGENTNET_AUTO_UPDATE === "1";
export const autoHour = () => { const h = Number(process.env.AGENTNET_AUTO_UPDATE_HOUR ?? 4); return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 4; };

/** The fixed argument list of the detached updater. Only the server-made id and a validated tag go in. */
export function updaterArgv(repo: string, id: string, tag: string, source: "web" | "auto"): string[] {
  return [process.execPath, join(repo, "src", "cli.ts"), "update", "--yes", source === "web" ? "--from-web" : "--from-auto", id, "--expect", tag];
}

/** What to start, as data so a test can read it. The server's resolved home, host and port go in explicitly: a scratch
 *  instance on another port must never fall back to defaults that point at the real one. */
export function spawnPlan(repo: string, home: string, argv: string[], mode: Mode, id: string, penv: NodeJS.ProcessEnv = process.env) {
  const own = { AGENTNET_HOME: home, AGENTNET_PORT: String(PORT), AGENTNET_HOST: HOST };
  const svc = { ...(penv.AGENTNET_SERVICE_UNIT ? { AGENTNET_SERVICE_UNIT: penv.AGENTNET_SERVICE_UNIT } : {}), ...(penv.AGENTNET_SERVICE_LABEL ? { AGENTNET_SERVICE_LABEL: penv.AGENTNET_SERVICE_LABEL } : {}) };
  if (mode === "systemd") {
    const set = Object.entries({ ...own, ...svc, ...(penv.PATH ? { PATH: penv.PATH } : {}) }).map(([k, v]) => `--setenv=${k}=${v}`);
    return { cmd: "systemd-run", args: ["--user", "--collect", `--unit=agentnet-update-${id}`, `--working-directory=${repo}`, ...set, ...argv],
      opts: { detached: true, stdio: "ignore" as const, cwd: repo } };
  }
  return { cmd: argv[0]!, args: argv.slice(1), opts: { detached: true, stdio: "ignore" as const, cwd: repo, env: { ...penv, ...own } } };
}

/** Outside the service, so the restart does not kill the updater. launchd: new session. systemd: its own transient unit. */
function realSpawn(repo: string, home: string): NonNullable<UpdateDeps["spawnUpdater"]> {
  return (argv, mode, id) => {
    const x = spawnPlan(repo, home, argv, mode, id);
    spawn(x.cmd, x.args, x.opts).unref();
  };
}

type Blocked = { code: string; hint: string } | null;
const SKIP_IN_STATUS: RefuseCode[] = ["fetch", "diverged"];

export function updateRoutes(api: Hono<Env>, d: UpdateDeps = {}): void {
  const repo = d.repo ?? REPO, home = d.home ?? ROOT;
  const spawnUpdater = d.spawnUpdater ?? realSpawn(repo, home);
  let modeAt = 0, modeVal: Mode = "unknown";
  const mode = async (): Promise<Mode> => {
    if (d.mode) return d.mode();
    if (Date.now() - modeAt > 30_000) { modeVal = await detectMode({ repo, host: HOST, port: PORT }, listenerPid(PORT)); modeAt = Date.now(); }
    return modeVal;
  };
  const doCheck = d.checkFn ?? ((force: boolean) => check({ force, home, repo }));
  const stateFile = join(home, "run", "update-state.json");

  const blocked = async (): Promise<Blocked> => {
    if (!webEnabled()) return { code: "web-disabled", hint: "Web updates are off on this machine. Run agentnet update in a terminal." };
    const m = await mode();
    if (m === "unknown") return { code: "no-service", hint: "agentnet is not running as a service, so the page cannot restart it. Run agentnet update in a terminal." };
    // Foreground: the updater restarts it from the launch record this process wrote at start.
    if (m === "foreground" && !(d.launchOk ? d.launchOk() : readLaunch(home)?.pid === process.pid)) return { code: "no-launch-record", hint: "agentnet does not know how it was started, so the page cannot restart it. Run agentnet update in a terminal." };
    const pre = preflight(repo, { home, fetch: false, allowLocalOrigin: d.allowLocalOrigin });
    if (!pre.ok && !SKIP_IN_STATUS.includes(pre.reason)) return { code: pre.reason, hint: pre.hint };
    return null;
  };

  const job = (): unknown => {
    try {
      const s = JSON.parse(readFileSync(stateFile, "utf8")) as JobResult & { running?: boolean; startedAt?: number };
      if (s.running && !readLock(home) && Date.now() - (s.startedAt ?? 0) > 60_000) return null; // the updater died
      return s.running ? s : { ...s, endedAt: Math.floor(statSync(stateFile).mtimeMs / 1000) };
    } catch { return null; }
  };

  const status = async () => {
    const cache = readCache(home);
    const latest = cache?.latest ?? null;
    const lv = latest ? parseTag(latest.tag) : null, cur = fromPackage(VERSION);
    return {
      current: VERSION, latest: latest?.version ?? null, available: !!(lv && cur && cmp(lv, cur) > 0),
      checkedAt: cache ? Math.floor(cache.checkedAt / 1000) : null, published: latest?.publishedAt ?? null, notes: latest?.notes ?? "", releaseUrl: latest?.url ?? "",
      checkEnabled: checkEnabled(), ...(cache?.error ? { error: cache.error } : {}),
      web: { enabled: webEnabled(), blocked: await blocked() }, mode: await mode(), auto: { enabled: autoOn(), hour: autoHour() }, job: job(),
    };
  };

  api.get("/agent-update", async (c) => c.json(await status()));
  api.post("/agent-update/check", rootOnly, async (c) => { await doCheck(true); return c.json(await status()); });

  api.post("/agent-update/run", rootOnly, async (c) => {
    if (!webEnabled()) return refuse(c, 403, "web-disabled", "Web updates are off on this machine.");
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.tag !== "string") return refuse(c, 400, "bad-body", 'Send exactly {"tag": "vX.Y.Z"}.');
    const want = parseTag(body.tag);
    if (!want) return refuse(c, 400, "bad-tag", "tag must look like v1.2.3.");
    const latest = readCache(home)?.latest, cur = fromPackage(VERSION);
    if (!latest || latest.tag !== want.tag || !cur || cmp(want, cur) <= 0) return refuse(c, 409, "not-latest", "That is not the newest release the check found.");
    const b = await blocked();
    if (b) return refuse(c, 409, b.code, b.hint);
    // A second click must not replace the state of a job that has not taken the lock yet.
    const prev = job() as { running?: boolean; startedAt?: number } | null;
    if (readLock(home) || (prev?.running && Date.now() - (prev.startedAt ?? 0) < 60_000)) return refuse(c, 409, "locked", "An update is already running.");
    const id = `upd-${(d.now ?? Date.now)()}`;
    try {
      mkdirSync(join(home, "run"), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ id, running: true, from: cur.tag, to: want.tag, startedAt: Date.now() }));
      spawnUpdater(updaterArgv(repo, id, want.tag, "web"), await mode(), id);
    } catch (e) { return refuse(c, 500, "spawn-failed", (e as Error).message); }
    logEvent("info", "web update started", { id, to: want.tag });
    return c.json({ id }, 202);
  });

  // Progress: the whole job log first (so a reconnect after the restart loses nothing), then new lines as they are written.
  api.get("/agent-update/stream", (c) => streamSSE(c, async (stream) => {
    const st = (() => { try { return JSON.parse(readFileSync(stateFile, "utf8")) as { id?: string }; } catch { return null; } })();
    const id = c.req.query("id") ?? st?.id;
    if (!id || !/^upd-\d+$/.test(id)) { await stream.writeSSE({ event: "hello", data: "[]" }); return; }
    const file = join(home, "run", `update-${id}.jsonl`);
    let offset = 0, buf = "", beat = Date.now(), waited = 0, sentHello = false;
    const lines = (): string[] => {
      if (!existsSync(file)) return [];
      const size = statSync(file).size;
      if (size <= offset) return [];
      const fd = openSync(file, "r"), b = Buffer.alloc(size - offset);
      try { readSync(fd, b, 0, b.length, offset); } finally { closeSync(fd); }
      offset = size; buf += b.toString("utf8");
      const parts = buf.split("\n"); buf = parts.pop() ?? "";
      return parts.filter(Boolean);
    };
    while (!stream.aborted) {
      const fresh = lines();
      if (!sentHello && (fresh.length || existsSync(file) || waited > 10_000)) {
        sentHello = true;
        await stream.writeSSE({ event: "hello", data: JSON.stringify(fresh.map((l) => JSON.parse(l))) });
      } else {
        for (const l of fresh) await stream.writeSSE({ event: "event", data: l });
      }
      if (sentHello && fresh.some((l) => (JSON.parse(l) as { type?: string }).type === "done")) return;
      if (Date.now() - beat > 15_000) { beat = Date.now(); await stream.writeSSE({ event: "ping", data: "" }); }
      await Bun.sleep(500); waited += 500;
    }
  }));
}

// ---------- timers: the release check and the optional auto update ----------

/** Pure gate for the auto update (T21). */
export function autoGate(o: { enabled: boolean; hour: number; nowDate: Date; available: boolean; tag: string | null; mode: Mode; working: boolean; lastRunAt: number | null; skipTag: string | null; locked: boolean }): { run: boolean; why: string } {
  if (!o.enabled) return { run: false, why: "off" };
  if (o.nowDate.getHours() !== o.hour) return { run: false, why: "not the hour" };
  if (!o.available || !o.tag) return { run: false, why: "nothing new" };
  if (o.skipTag === o.tag) return { run: false, why: "rolled back on this tag before" };
  if (o.mode !== "launchd" && o.mode !== "systemd") return { run: false, why: "not a service" };
  if (o.working) return { run: false, why: "an agent is working" };
  if (o.locked) return { run: false, why: "an update is running" };
  if (o.lastRunAt !== null && o.nowDate.getTime() - o.lastRunAt < 20 * 3600_000) return { run: false, why: "ran in the last 20 h" };
  return { run: true, why: "go" };
}

export function startUpdateTimers(d: UpdateDeps = {}): void {
  const repo = d.repo ?? REPO, home = d.home ?? ROOT;
  const doCheck = d.checkFn ?? ((force: boolean) => check({ force, home, repo }));
  const safe = (fn: () => Promise<unknown>) => () => { fn().catch((e) => logEvent("warn", "update timer failed", { error: String(e) })); };
  if (checkEnabled()) {
    setTimeout(safe(() => doCheck(false)), 30_000).unref();
    setInterval(safe(() => doCheck(false)), 6 * 3600_000).unref();
  }
  if (autoOn()) setInterval(safe(() => autoTick(d)), 10 * 60_000).unref();
}

/** One auto-update decision; starts the same detached updater as the web button. Exported for tests. */
export async function autoTick(d: UpdateDeps = {}): Promise<{ run: boolean; why: string }> {
  const repo = d.repo ?? REPO, home = d.home ?? ROOT;
  const m = d.mode ? await d.mode() : await detectMode({ repo, host: HOST, port: PORT }, listenerPid(PORT));
  const cache = readCache(home), latest = cache?.latest ?? null, lv = latest ? parseTag(latest.tag) : null, cur = fromPackage(VERSION);
  const st = (() => { try { return JSON.parse(readFileSync(join(home, "run", "update-state.json"), "utf8")) as { skipTag?: string; startedAt?: number; running?: boolean; outcome?: string; id?: string }; } catch { return null; } })();
  const lastRunAt = st?.id ? Number(/^upd-(\d+)$/.exec(st.id)?.[1]) || null : null;
  const g = autoGate({
    enabled: autoOn(), hour: autoHour(), nowDate: new Date((d.now ?? Date.now)()), available: !!(lv && cur && cmp(lv, cur) > 0), tag: latest?.tag ?? null, mode: m,
    working: live().some((s) => s.state === "working"), lastRunAt, skipTag: st?.skipTag ?? null, locked: !!readLock(home),
  });
  if (!g.run || !latest) return g;
  const pre = preflight(repo, { home, fetch: false, allowLocalOrigin: d.allowLocalOrigin });
  if (!pre.ok) return { run: false, why: `blocked (${pre.reason})` };
  const id = `upd-${(d.now ?? Date.now)()}`;
  (d.spawnUpdater ?? realSpawn(repo, home))(updaterArgv(repo, id, latest.tag, "auto"), m, id);
  logEvent("info", "auto update", { id, to: latest.tag });
  return g;
}
