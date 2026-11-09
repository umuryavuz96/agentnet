import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

async function run(cmd: string[], opts: { stdin?: string; env?: Record<string, string>; cwd?: string } = {}) {
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd ?? REPO, stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : undefined, stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH!, HOME: tmp("an-home-"), AGENTNET_HOME: tmp("an-data-"), AGENTNET_TRIAGE_LOG: "off", AGENTNET_BIN: join(REPO, "bin", "agentnet"), ...opts.env },
  });
  const [stdout, stderr] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  return { stdout, stderr, code: await p.exited };
}
const cli = (args: string[], o = {}) => run([process.execPath, "run", "src/cli.ts", ...args], o);
const triage = (prompt: string, env: Record<string, string> = {}, args: string[] = []) =>
  run(["python3", "hooks/triage.py", ...args], { stdin: JSON.stringify({ prompt }), env });

describe("agentnet council (plan mode)", () => {
  test("prints moderator, council members and integrators; spawns and writes nothing", async () => {
    const proj = tmp("an-proj-");
    const r = await cli(["council", proj, "demo", "build a settings page", "ux-designer=ux design,security=security review,critic=product critic", "web-dev"]);
    expect(r.code).toBe(0);
    const names = r.stdout.split("\n").filter((l) => /model=/.test(l)).map((l) => l.split(/\s+/)[0]);
    expect(names).toEqual(["architect-1", "ux-designer-1", "security-1", "critic-1", "web-dev-1"]);
    expect(r.stdout).toContain("dry-run: add --go to spawn");
    expect(existsSync(join(proj, "docs"))).toBe(false);
  });
  test("warns on 2 angles, refuses more than 8 agents, rejects unknown options", async () => {
    const proj = tmp("an-proj-");
    const two = await cli(["council", proj, "t", "j", "a,b", "backend"]);
    expect(two.code).toBe(0);
    expect(two.stderr).toContain("3-5 angles");
    const nine = await cli(["council", proj, "t", "j", "a,b,c,d,e", "backend,web-dev,qa"]);
    expect(nine.code).toBe(1);
    expect(nine.stderr).toContain("max 8 agents");
    const bad = await cli(["council", proj, "t", "j", "a,b,c", "backend", "--nope"]);
    expect(bad.code).toBe(2);
  });
  test("too few arguments prints usage", async () => {
    const r = await cli(["council", "x"]);
    expect(r.code).toBe(2);
  });
});

describe("triage hook (stub mode)", () => {
  const stub = JSON.stringify({ kind: "feature", complexity: 4, risk: 1, route: "team", role: "web-dev", scope: 3, novelty: 2, specialty: "ui forms",
    council: "UX Designer, Security", integrators: "web-dev", reason: "multi-file UI" });
  const ctx = (out: string) => JSON.parse(out).hookSpecificOutput.additionalContext as string;

  test("team route: [triage] line with model, soul and council", async () => {
    const r = await triage("build a settings page for the app", { AGENTNET_TRIAGE_STUB: stub });
    expect(r.code).toBe(0);
    const c = ctx(r.stdout);
    expect(c).toStartWith("[triage] kind=feature complexity=4 risk=1 route=team role=web-dev -> mode=");
    expect(c).toMatch(/model=\w+ effort=\w+ score=-?\d+/);
    expect(c).toContain("council=ux-designer,security integrators=web-dev");
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });
  test("inline route: no pick-model, no council", async () => {
    const r = await triage("what is a mutex?", { AGENTNET_TRIAGE_STUB: JSON.stringify({ kind: "question", route: "inline", role: "none", reason: "knowledge" }) });
    const c = ctx(r.stdout);
    expect(c).toContain("route=inline");
    expect(c).not.toContain("->");
    expect(c).not.toContain("council=");
  });
  test("--self-test works with no key and no stub", async () => {
    const r = await triage("build a settings page", {}, ["--self-test"]);
    expect(ctx(r.stdout)).toContain("reason: self-test stub");
  });
  test("fails open: no key, bad stub, skipped prompts, bad stdin all print nothing and exit 0", async () => {
    for (const [p, env] of [["build a settings page", {}], ["build a settings page", { AGENTNET_TRIAGE_STUB: "{not json" }], ["/help me", { AGENTNET_TRIAGE_STUB: stub }], ["ok", { AGENTNET_TRIAGE_STUB: stub }]] as const) {
      const r = await triage(p, { ANTHROPIC_API_KEY: "", ...env });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
    const bad = await run(["python3", "hooks/triage.py"], { stdin: "not json" });
    expect([bad.code, bad.stdout]).toEqual([0, ""]);
  });
  test("writes a log line that never holds the key", async () => {
    const log = join(tmp("an-log-"), "triage.jsonl");
    await triage("build a settings page", { AGENTNET_TRIAGE_STUB: stub, AGENTNET_TRIAGE_LOG: log, ANTHROPIC_API_KEY: "sk-test-secret" });
    const text = readFileSync(log, "utf8");
    expect(JSON.parse(text.trim()).route).toBe("team");
    expect(text).not.toContain("sk-test-secret");
  });
});

describe("agentnet install-hooks", () => {
  test("prints a snippet and writes nothing without --write", async () => {
    const f = join(tmp("an-set-"), "settings.json");
    const r = await cli(["install-hooks"], { env: { CLAUDE_SETTINGS_FILE: f } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hooks.UserPromptSubmit[0].hooks[0].command).toContain("hooks/triage.py");
    expect(existsSync(f)).toBe(false);
  });
  test("--write backs up, keeps other keys, and is idempotent", async () => {
    const dir = tmp("an-set-"), f = join(dir, "settings.json");
    writeFileSync(f, JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }));
    const env = { CLAUDE_SETTINGS_FILE: f };
    const a = await cli(["install-hooks", "--write"], { env });
    expect(a.stdout).toContain("backup ");
    const j = JSON.parse(readFileSync(f, "utf8"));
    expect(j.theme).toBe("dark");
    expect(j.hooks.Stop).toHaveLength(1);
    expect(j.hooks.UserPromptSubmit).toHaveLength(1);
    const b = await cli(["install-hooks", "--write"], { env });
    expect(b.stdout).toContain("already installed");
    expect(JSON.parse(readFileSync(f, "utf8")).hooks.UserPromptSubmit).toHaveLength(1);
  });
  test("--write refuses a settings file that is not JSON", async () => {
    const f = join(tmp("an-set-"), "settings.json");
    writeFileSync(f, "{oops");
    const r = await cli(["install-hooks", "--write"], { env: { CLAUDE_SETTINGS_FILE: f } });
    expect(r.code).toBe(1);
    expect(readFileSync(f, "utf8")).toBe("{oops");
  });
});

describe("shipped files", () => {
  test("scripts parse and rules exist", async () => {
    for (const s of ["scripts/council.sh"]) expect((await run(["bash", "-n", s])).code).toBe(0);
    for (const f of ["docs/rules/council-teams.md", "docs/rules/model-routing.md", "docs/director.md"]) expect(existsSync(join(REPO, f))).toBe(true);
  });
});
