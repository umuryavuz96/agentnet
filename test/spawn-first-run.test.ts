import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fakeServer, json } from "./fake";

const REPO = resolve(import.meta.dir, "..");
const servers: { stop(): void }[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

function setup(tmuxScript: string) {
  const t = mkdtempSync(join(tmpdir(), "an-first-")), bin = join(t, "bin"); mkdirSync(bin);
  const proj = join(t, "projects", "money-map"); mkdirSync(proj, { recursive: true });
  writeFileSync(join(t, "projects", ".mcp.json"), JSON.stringify({ mcpServers: { playwright: {}, other: {} } }));
  writeFileSync(join(t, ".claude.json"), JSON.stringify({ projects: {} }));
  writeFileSync(join(bin, "tmux"), tmuxScript); writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
  for (const n of ["tmux", "claude"]) chmodSync(join(bin, n), 0o755);
  const f = fakeServer({
    "POST /api/v1/agentnet/spawn": () => json({ token_file: join(t, "t-3.token"), agent: "t-3#1", state: "starting" }, 201),
    "POST /api/v1/agentnet/agents/t-3/placement": () => json({}),
    "GET /api/v1/agentnet/agents/t-3": () => json({ life: "starting" }),
  });
  servers.push(f);
  const run = async (args: string[]) => {
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: t, AGENTNET_HOME: join(t, "data"), ARSENAL_DIR: t, TMPDIR: t, AGENTNET_URL: `${f.url}/api/v1/agentnet`, T: t };
    const p = Bun.spawn([process.execPath, "run", "src/cli.ts", "spawn", "t-3", "--job", "j", "--project", proj, ...args], { env, cwd: REPO, stdout: "pipe", stderr: "pipe" });
    const [stderr, exitCode] = [await new Response(p.stderr).text(), await p.exited];
    return { stderr, exitCode };
  };
  return { t, proj, run };
}

test("spawn answers the trust and .mcp.json questions before it starts the session", async () => {
  const { t, proj, run } = setup("#!/bin/sh\nexit 0\n");
  const r = await run(["--no-wait"]);
  expect(r.exitCode).toBe(0);
  const e = JSON.parse(readFileSync(join(t, ".claude.json"), "utf8")).projects[proj];
  expect(e.hasTrustDialogAccepted).toBe(true);
  expect(e.enabledMcpjsonServers).toEqual(["playwright"]);
  expect(e.disabledMcpjsonServers).toEqual(["other"]);
});

test("--mcp picks the servers to enable", async () => {
  const { t, proj, run } = setup("#!/bin/sh\nexit 0\n");
  await run(["--no-wait", "--mcp", "other"]);
  const e = JSON.parse(readFileSync(join(t, ".claude.json"), "utf8")).projects[proj];
  expect(e.enabledMcpjsonServers).toEqual(["other"]); expect(e.disabledMcpjsonServers).toEqual(["playwright"]);
});

test("a session that dies before it joins prints its last screen lines, never silence", async () => {
  // first has-session: alive with a dialog on screen; second: gone
  const tmux = `#!/bin/sh
case "$1" in
  has-session) if [ -f "$T/seen" ]; then exit 1; fi; : > "$T/seen"; exit 0 ;;
  capture-pane) printf 'Do you trust the files in this folder?\\n  1. Yes, proceed\\n  2. No, exit\\n' ;;
esac
exit 0
`;
  const { run } = setup(tmux);
  const r = await run(["--ready-timeout", "10"]);
  expect(r.stderr).toContain("status=session-ended");
  expect(r.stderr).toContain("last lines of the session");
  expect(r.stderr).toContain("| Do you trust the files in this folder?");
  expect(r.stderr).toContain("status=spawned-not-yet-live");
});
