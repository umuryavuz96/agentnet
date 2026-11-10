// Reset director = a fresh install: setup, reset, setup again must leave the same files and build the same launch command.
// Scratch AGENTNET_HOME, no tmux (the start is a stub), no live server.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "an-reset-"));
const ENV = ["AGENTNET_HOME", "TMUX"];
const old: Record<string, string | undefined> = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
process.env.AGENTNET_HOME = join(tmp, "agentnet"); delete process.env.TMUX;
mkdirSync(process.env.AGENTNET_HOME, { recursive: true });
afterAll(() => { for (const k of ENV) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } });
const { Database } = await import("bun:sqlite");
{ const { useDatabase } = await import("../core/db"); useDatabase(new Database(":memory:")); (await import("./store"))._reset(); }
const dr = await import("./director");
const ad = await import("./adopt");
const { markLaunch, launchView } = await import("./launch");
const ROOT = process.env.AGENTNET_HOME!;

const files = (dir: string, out: string[] = []): string[] => { if (!existsSync(dir)) return out; for (const n of readdirSync(dir).sort()) { const p = join(dir, n); if (statSync(p).isDirectory()) files(p, out); else if (!p.slice(ROOT.length).startsWith("/logs")) out.push(p.slice(ROOT.length)); } return out; };
const started: { dir: string; opts: Record<string, unknown> }[] = [];
ad.seams.startDirector = ((dir: string, _r: unknown, _t: unknown, _e: unknown, opts: Record<string, unknown>) => {
  // what the real start writes: prompt file + director home; then the command it would run
  const promptFile = dr.writeDirectorPrompt({ mode: "clean", workspace: dir }, ROOT);
  const home = dr.ensureDirectorHome(ROOT);
  started.push({ dir, opts, cmd: dr.directorCommand(dir, { mode: "clean", promptFile, home }) } as never);
  markLaunch("agentnet-root");
  return { ok: true, session: "agentnet-root", attach: "tmux attach -t agentnet-root" };
}) as never;
ad.seams.killScanSession = () => false; ad.seams.hasRoot = () => false; ad.seams.hasSession = () => false;
const reset = () => dr.resetDirector({ pid: () => null, session: () => null, killSession: () => false, signal: () => {}, gone: async () => true, backup: () => {}, forget: () => [], clean: () => [...ad.resetAdopt(), ...dr.cleanDirectorFiles(ROOT)] });

test("setup, reset, setup again: first-run state and the same launch command", async () => {
  const proj = mkdtempSync(join(tmp, "proj-"));
  const before = files(ROOT);
  expect(ad.startClean(proj).ok).toBe(true);
  const firstFiles = files(ROOT);
  expect(ad.loadState().phase).toBe("applied");
  expect(launchView().state).not.toBe("idle");

  const r = await reset();
  expect(r.ok).toBe(true);
  expect(files(ROOT)).toEqual(before);                 // nothing of the setup is left under the agentnet home
  expect(ad.loadState().phase).toBe("idle");           // the panel starts at step 1, not at "Director ready"
  expect(ad.loadState().workspace).toBeNull();
  expect(launchView().state).toBe("idle");             // no stale launch mark

  expect(ad.startClean(proj).ok).toBe(true);
  expect(files(ROOT)).toEqual(firstFiles);             // same files as the first setup
  expect(started).toHaveLength(2);
  const [a, b] = started as unknown as { cmd: string }[];
  expect(b.cmd).toBe(a.cmd);
  expect(b.cmd).not.toContain("--resume");
});

test("reset keeps a CLAUDE.md the user edited and never touches the project", async () => {
  const proj = mkdtempSync(join(tmp, "proj-"));
  writeFileSync(join(proj, "mine.txt"), "keep");
  ad.startClean(proj);
  writeFileSync(join(ROOT, "director", "CLAUDE.md"), "my own notes\n");
  await reset();
  expect(readFileSync(join(ROOT, "director", "CLAUDE.md"), "utf8")).toBe("my own notes\n");
  expect(readFileSync(join(proj, "mine.txt"), "utf8")).toBe("keep");
  expect(ad.loadState().phase).toBe("idle");
});
