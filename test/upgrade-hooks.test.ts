// Step 8a: the plugin's upgrade hooks (re-inject, post-call matcher, proof) and the proof-gaming guard, against a fake host
// and the real routes. Spec: docs/internal/one-folder/SPEC-step8-lines.md (job 8a, tests 6, 7, 13).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-uphooks-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../src/core/db");
const { tracing } = await import("../src/core/http");
type Env = import("../src/core/http").Env;
const st = await import("../src/net/store");
const rt = await import("../src/net/routes");
const sc = await import("../src/net/scores");
const fin = await import("../src/net/finish");
const ln = await import("../src/net/lines");
type Check = import("../src/net/lines").Check;
const tr = await import("./helpers/transcript");
const CH = tr.scratchClaudeHome(), CWD = "/fixture/hooks-work";

const app = new Hono<Env>(); app.use("*", tracing); const api = new Hono<Env>(); rt.agentnetRoutes(api); app.route("/api/v1", api);
const tok: Record<string, string> = {};
const call = (who: string, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/agentnet${path}`, { method, headers: { authorization: `Bearer ${tok[who] ?? who}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
fin.finishDeps.procs = { table: () => [], panePids: () => [], portPids: () => [], signal: () => {}, alive: () => true, later: (fn) => fn(), killSession: () => {} };
beforeAll(async () => {
  process.env.AGENTNET_LINES = "1"; await ln.registerLineHandlers();
  useDatabase(new Database(":memory:")); st._reset(); sc.useScoreDb(new Database(":memory:"));
  tok.root = rt.createAgent({ name: "root", job: "t", by: "test", standing: true }).token;
});
afterAll(() => { delete process.env.AGENTNET_LINES; CH.restore(); });

const tokenFile = join(mkdtempSync(join(tmpdir(), "an-uphooks-tok-")), "a.token");
type H = (...a: unknown[]) => Promise<unknown>;
let n = 0;
/** A fresh copy of the mod on a fake host whose HTTP goes to the real routes as agent `who`. */
async function host(who: string) {
  writeFileSync(tokenFile, tok[who]!);
  const { register } = await import(`../plugin/hooks/register.ts?u=${++n}`);
  const handlers: Record<string, H[]> = {}, appended: string[] = [], posted: { path: string; body: unknown }[] = [];
  register((name: string, ...rest: unknown[]) => { (handlers[name] ??= []).push(rest.at(-1) as H); });
  const $ = {
    env: { get: async (k: string) => (k === "AGENTNET_TOKEN_FILE" ? tokenFile : null) }, fs: { read: async () => tok[who] },
    session: { id: async () => `sid-${who}`, model: async () => "m", version: async () => ({ version: "2.1.327" }), append: async (m: { message: { content: { text: string }[] } }) => { appended.push(m.message.content[0]!.text); } },
    process: { run: async () => ({ stdout: "4242\n" }) }, prompt: { submit: async () => {} }, ui: { status: () => {}, log: () => {} }, tool: { register: async () => {} },
    clock: { after: () => {}, sleep: async () => {} }, agent: { list: async () => [] },
    http: { fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const path = url.replace(/^.*\/api\/v1\/agentnet/, ""); if (path.startsWith("/upgrade-proof") || path === "/events") posted.push({ path, body: init?.body ? JSON.parse(init.body) : null });
      const r = await app.request(`/api/v1/agentnet${path}`, { method: init?.method ?? "GET", headers: init?.headers, body: init?.body });
      return { ok: r.ok, status: r.status, text: await r.text() };
    } },
  };
  const general = () => handlers["tool.call"]!.at(-1)!; // registered last
  // Claude Code writes the call and its result to the session's transcript; the hook then fires with the same tool_use_id
  const toolCall = (ev: Record<string, unknown>, result: { stdout?: string }) => {
    const id = `toolu_fixture${String(++n).padStart(4, "0")}`, { tool, ...input } = ev;
    tr.writeCall(tr.transcriptPath(CH.home, CWD, `sid-${who}`), { id, tool: String(tool), input, output: result.stdout ?? "" });
    return general()($, { tool_use_id: id, ...ev }, async () => ({ result }));
  };
  const mcp = (name: string, args: Record<string, unknown>) => handlers["tool.call"]!.find((_, k) => k === toolIndex[name])!($, { tool: `mcp__agentnet__${name}`, ...args }, async (x: unknown) => x);
  const fire = (name: string, e: Record<string, unknown> = {}) => handlers[name]![0]!($, e, async (x: unknown) => x);
  await fire("session.start"); await Bun.sleep(5);
  return { toolCall, mcp, fire, appended, proofs: () => posted.filter((p) => p.path === "/upgrade-proof") };
}
// The mod registers one tool.call handler per ROUTES entry, in ROUTES order, then the general one: map tool name -> its index.
const toolIndex: Record<string, number> = {};
{
  const src = await Bun.file(join(import.meta.dir, "../plugin/hooks/register.ts")).text();
  const body = src.slice(src.indexOf("const ROUTES"), src.indexOf("/** Secrets typed"));
  const names = [...body.matchAll(/\b([a-z_]+): (?:\(a\)|\(\))\s*=>/g)].map((m) => m[1]!);
  names.forEach((x, i) => { toolIndex[x] = i; });
}

async function agent(name: string, steps = 1) {
  const made = rt.createAgent({ name, boss: "root", job: "t", goal: "g", by: "test", project: CWD }, Date.now() - 60_000);
  tok[name] = made.token;
  rt.startJob(made.id, { by: "root", goal: "fixture job", steps: Array.from({ length: steps }, (_, i) => `outcome ${i + 1}`) });
  return made.id;
}
const UI: Check = { tool: "Bash", command_includes: "ui-check.mjs", output_includes: "PASS" };

test("hooks: a Bash ui-check PASS call posts proof; a report without proof is refused (before_report)", async () => {
  await agent("hk-1");
  const h = await host("hk-1");
  const up = await h.mcp("self_upgrade", { text: "Run ui-check on every page I touch before I report done.", scope: "before_report", check: UI }) as { result?: string; deny?: string };
  expect(up.deny).toBeUndefined();
  await h.fire("turn.start", { turnId: "t1", text: "go" });
  expect(h.appended).toContain("Your upgrade: Run ui-check on every page I touch before I report done.");
  expect((await call("hk-1", "POST", "/steps/done", { evidence: ["check: bun test 1 pass 0 fail"] })).status).toBe(200);
  const refused = await call("hk-1", "POST", "/report", { summary: "Done.", state: "done" });
  expect(refused.status).toBe(409); expect(((await refused.json()) as { detail: string }).detail).toContain("Your upgrade: Run ui-check");
  // a call that does not match posts nothing; the real ui-check run does
  await h.toolCall({ tool: "Bash", command: "bun test" }, { stdout: "9 pass 0 fail" });
  await h.toolCall({ tool: "Bash", command: "node ~/scripts/lib/ui-check/ui-check.mjs http://127.0.0.1:3231/" }, { stdout: "ui-check: PASS 390x844 light\nui-check: PASS 1920x1080 dark" });
  await Bun.sleep(10);
  expect(h.proofs().length).toBe(1);
  expect((h.proofs()[0]!.body as { evidence: string }).evidence).toMatch(/^Bash: node .*ui-check\.mjs .* => .*PASS 390x844/);
  expect(ln.proofsOf("hk-1", 1)).toHaveLength(1);
  // the re-inject before the closing call, then the report goes through
  const before = h.appended.length;
  await h.mcp("report", { summary: "Done: hk-1.", state: "done" });
  expect(h.appended.length).toBe(before + 1);
  expect(ln.upgradeOf("hk-1", 1)!.status).toBe("kept");
});

test("hooks: file_glob and commit_msg_includes match; judgment proof counts half", async () => {
  const m = ln.matchCheck;
  expect(m({ file_glob: "docs/**/*.md" }, { tool: "Write", input: { file_path: "/repo/docs/internal/a.md" }, output: "" })).toBe("Write /repo/docs/internal/a.md");
  expect(m({ file_glob: "docs/**/*.md" }, { tool: "Edit", input: { file_path: "/repo/docs/a.md" }, output: "" })).not.toBeNull();
  expect(m({ file_glob: "docs/**/*.md" }, { tool: "Write", input: { file_path: "/repo/src/a.md" }, output: "" })).toBeNull();
  expect(m({ file_glob: "docs/**/*.md" }, { tool: "Read", input: { file_path: "/repo/docs/a.md" }, output: "" })).toBeNull(); // reads prove nothing
  const commit = `git commit -m "$(cat <<'EOF'\nfeat(lines): step 3. hooks\n\nCo-Authored-By: x\nEOF\n)"`;
  expect(m({ commit_msg_includes: "step 3." }, { tool: "Bash", input: { command: commit }, output: "[main 1a2b3c4] feat(lines): step 3. hooks\n 2 files changed" })).toContain("git commit");
  expect(m({ commit_msg_includes: "step 3." }, { tool: "Bash", input: { command: commit }, output: "nothing to commit, working tree clean" })).toBeNull(); // no commit made
  expect(m({ commit_msg_includes: "step 3." }, { tool: "Bash", input: { command: "git commit -m 'other'" }, output: "[main 1a2b3c4] other" })).toBeNull();
  // judgment: a single agent proof is not adherence, two are
  const p = (source: "hook" | "agent") => ({ source });
  expect(ln.adheres([p("agent")])).toBe(false);
  expect(ln.adheres([p("agent"), p("agent")])).toBe(true);
  expect(ln.adheres([p("hook")])).toBe(true);
  await agent("hk-2");
  expect((await call("hk-2", "POST", "/self-upgrade", { text: "Commit with a message that names the step it closes.", scope: "before_report", check: { commit_msg_includes: "closes step" } })).status).toBe(201);
  expect((await call("hk-2", "POST", "/upgrade-proof/agent", { evidence: "I did" })).status).toBe(409); // agent proof only for judgment
});

test("hooks: echo/printf/heredoc/true commands and command-text echoes give no proof; command_includes of only echo is rejected", async () => {
  const m = (cmd: string, out = "PASS", check: Check = UI) => ln.matchCheck(check, { tool: "Bash", input: { command: cmd }, output: out });
  expect(m('echo "node ui-check.mjs PASS"', "node ui-check.mjs PASS")).toBeNull();
  expect(m("printf 'ui-check.mjs PASS\\n'", "ui-check.mjs PASS")).toBeNull();
  expect(m("cd /repo && FOO=1 echo ui-check.mjs PASS", "ui-check.mjs PASS")).toBeNull();
  expect(m("true ui-check.mjs PASS")).toBeNull();
  expect(m("cat <<EOF\nnode ui-check.mjs http://x\nPASS\nEOF", "node ui-check.mjs http://x\nPASS")).toBeNull();
  expect(m("node -e 'console.log(\"PASS\")' # ui-check.mjs", "PASS")).toBeNull(); // the PASS comes from the command text echoed back
  expect(m("cd /repo && node ui-check.mjs http://x", "PASS 390x844")).not.toBeNull(); // the real thing
  expect(m("node ui-check.mjs http://x", "FAIL 390x844")).toBeNull();
  expect(ln.matchCheck({ tool: "Bash", command_includes: "ui-check.mjs" }, { tool: "Bash", input: { command: "echo ui-check.mjs" }, output: "ui-check.mjs" })).toBeNull();
  expect(ln.matchCheck(UI, { tool: "Bash", input: { command: "node ui-check.mjs" }, output: "PASS", isError: true })).toBeNull();
  for (const bad of ["echo", "printf", " ECHO ", "true", "cat <<"]) expect("error" in ln.parseCheck({ tool: "Bash", command_includes: bad })).toBe(true);
  expect("error" in ln.parseCheck({ tool: "Bash", command_includes: "echo hello world" })).toBe(false); // only "only echo" is refused
});

test("hooks: the plugin's matcher is an identical copy of lines.ts", async () => {
  const cut = (s: string) => s.slice(s.indexOf("// ---- copy start"), s.indexOf("// ---- copy end ----")).split("\n").slice(1).join("\n");
  const a = cut(await Bun.file(join(import.meta.dir, "../src/net/lines.ts")).text()), b = cut(await Bun.file(join(import.meta.dir, "../plugin/hooks/register.ts")).text());
  expect(a.length).toBeGreaterThan(500); expect(b).toBe(a);
});

test("hooks: one case table gives equal results through the server matcher and the plugin matcher", async () => {
  const plug: { matchCheck: typeof ln.matchCheck } = await import(`../plugin/hooks/register.ts?m=${++n}`); // a template path keeps the plugin out of tsc, as in mod.test.ts
  const B = (command: string, output = "PASS"): Parameters<typeof ln.matchCheck>[1] => ({ tool: "Bash", input: { command }, output });
  const commit = "git commit -m \"$(cat <<'EOF'\nfeat: step 3. x\nEOF\n)\"";
  const cases: [Check, Parameters<typeof ln.matchCheck>[1]][] = [
    [UI, B("node ui-check.mjs http://x", "PASS 390x844")], [UI, B("cd /r && node ui-check.mjs http://x", "PASS")], [UI, B("node ui-check.mjs", "FAIL")],
    [UI, B('echo "node ui-check.mjs PASS"', "node ui-check.mjs PASS")], [UI, B("printf 'ui-check.mjs PASS'", "ui-check.mjs PASS")], [UI, B("true ui-check.mjs PASS")],
    [UI, B("FOO=1 echo ui-check.mjs PASS", "ui-check.mjs PASS")], [UI, B("cat <<EOF\nui-check.mjs\nPASS\nEOF", "ui-check.mjs\nPASS")], [UI, B("node -e 'console.log(\"PASS\")' # ui-check.mjs")],
    [UI, { tool: "Bash", input: { command: "node ui-check.mjs" }, output: "PASS", isError: true }], [UI, { tool: "Write", input: { file_path: "ui-check.mjs" }, output: "PASS" }],
    [{ file_glob: "docs/**/*.md" }, { tool: "Write", input: { file_path: "/r/docs/a/b.md" }, output: "" }], [{ file_glob: "docs/**/*.md" }, { tool: "Read", input: { file_path: "/r/docs/a.md" }, output: "" }],
    [{ commit_msg_includes: "step 3." }, B(commit, "[main 1a2b3c4] feat: step 3. x")], [{ commit_msg_includes: "step 3." }, B(commit, "nothing to commit")], [{ commit_msg_includes: "step 3." }, B("echo git commit step 3.", "[main 1a2b3c4] x")],
    [{ judgment: true }, B("anything")], [{ tool: "Bash", command_includes: "token=abcdefghijklmnopqrstuvwxyz0123456789" }, B("curl token=abcdefghijklmnopqrstuvwxyz0123456789", "")],
  ];
  const server = cases.map(([c, x]) => ln.matchCheck(c, x)), plugin = cases.map(([c, x]) => plug.matchCheck(c, x));
  expect(plugin).toEqual(server);
  expect(server.filter((v) => v != null).length).toBe(5); // 2 real ui-check runs, the docs write, the real commit, the curl; every gaming case is null
  expect(server.every((v) => v == null || !v.includes("abcdefghijklmnopqrstuvwxyz0123456789"))).toBe(true); // evidence is redacted
});
