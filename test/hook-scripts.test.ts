// The hook scripts that ship in hooks/: each one is fed sample stdin JSON, in a temp agentnet home, and must fail open.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
function hook(script: string, stdin: unknown, env: Record<string, string> = {}) {
  const home = env.AGENTNET_HOME ?? tmp("an-hook-");
  const p = Bun.spawnSync(["python3", join(REPO, "hooks", script)], {
    stdin: new TextEncoder().encode(typeof stdin === "string" ? stdin : JSON.stringify(stdin)),
    env: { PATH: process.env.PATH!, HOME: tmp("an-h-"), AGENTNET_HOME: home, ...env },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), home };
}
const now = () => Math.floor(Date.now() / 1000);

describe("usage-guard.py", () => {
  const usage = (home: string, pct: number, fetchedAt = now(), resetsAt = now() + 3600) => {
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(join(home, "data", "claude-usage.json"), JSON.stringify({ last: { fetchedAt, windows: [{ key: "five_hour", pct, resetsAt }, { key: "seven_day", pct: 10, resetsAt: now() + 86400 }] } }));
  };
  const agent = { tool_name: "Agent", tool_input: { prompt: "x" } };
  test("blocks heavy work above the limit, with a reason on stderr, and logs it", () => {
    const home = tmp("an-ug-"); usage(home, 95);
    const r = hook("usage-guard.py", agent, { AGENTNET_HOME: home, AGENTNET_AGENT: "backend-1" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("5-hour window is at 95%");
    expect(r.err).toContain(join(home, "state", "usage-override"));
    expect(JSON.parse(readFileSync(join(home, "logs", "usage-guard.jsonl"), "utf8").trim())).toMatchObject({ agent: "backend-1", window: "five_hour", used: 95 });
    for (const s of [{ tool_name: "Bash", tool_input: { command: "bun run build" } }, { tool_name: "Read", agent_id: "sub-1", tool_input: {} }]) expect(hook("usage-guard.py", s, { AGENTNET_HOME: home }).code).toBe(2);
  });
  test("light work passes even at 100%", () => {
    const home = tmp("an-ug-"); usage(home, 100);
    for (const s of [{ tool_name: "Read", tool_input: { file_path: "/x" } }, { tool_name: "Bash", tool_input: { command: "ls -la" } }]) expect(hook("usage-guard.py", s, { AGENTNET_HOME: home }).code).toBe(0);
  });
  test("passes below the limit, with a custom limit, with stale or reset data, and with the override", () => {
    const home = tmp("an-ug-");
    usage(home, 85); expect(hook("usage-guard.py", agent, { AGENTNET_HOME: home }).code).toBe(0);
    expect(hook("usage-guard.py", agent, { AGENTNET_HOME: home, AGENTNET_USAGE_LIMIT: "80" }).code).toBe(2);
    usage(home, 99, now() - 4 * 3600); expect(hook("usage-guard.py", agent, { AGENTNET_HOME: home }).code).toBe(0);
    usage(home, 99, now(), now() - 60); expect(hook("usage-guard.py", agent, { AGENTNET_HOME: home }).code).toBe(0);
    usage(home, 99); mkdirSync(join(home, "state"), { recursive: true }); writeFileSync(join(home, "state", "usage-override"), "");
    expect(hook("usage-guard.py", agent, { AGENTNET_HOME: home }).code).toBe(0);
    const old = Date.now() / 1000 - 3 * 3600; utimesSync(join(home, "state", "usage-override"), old, old);
    expect(hook("usage-guard.py", agent, { AGENTNET_HOME: home }).code).toBe(2);
  });
  test("reads the status line snapshot too, and takes the fresher source", () => {
    const home = tmp("an-ug-"), snap = join(home, "snap.json");
    writeFileSync(snap, JSON.stringify({ ts: now(), windows: { seven_day: { used: 92, resets_at: now() + 86400 } } }));
    const r = hook("usage-guard.py", agent, { AGENTNET_HOME: home, AGENTNET_USAGE_SNAPSHOT: snap });
    expect([r.code, r.err.includes("weekly")]).toEqual([2, true]);
    usage(home, 10, now() + 5); // fresher, low
    expect(hook("usage-guard.py", agent, { AGENTNET_HOME: home, AGENTNET_USAGE_SNAPSHOT: snap }).code).toBe(0);
  });
  test("fails open: no data, broken data, bad stdin", () => {
    const home = tmp("an-ug-");
    expect(hook("usage-guard.py", agent, { AGENTNET_HOME: home }).code).toBe(0);
    mkdirSync(join(home, "data")); writeFileSync(join(home, "data", "claude-usage.json"), "{ nope");
    expect(hook("usage-guard.py", agent, { AGENTNET_HOME: home }).code).toBe(0);
    usage(home, 99);
    const bad = hook("usage-guard.py", "not json", { AGENTNET_HOME: home });
    expect([bad.code, bad.out]).toEqual([0, ""]);
  });
});

describe("task-guard.py", () => {
  const call = (home: string, extra: Record<string, string> = {}, tool = "Read") =>
    hook("task-guard.py", { session_id: "s-1", tool_name: tool }, { AGENTNET_HOME: home, AGENTNET_AGENT: "web-dev-1", AGENTNET_URL: "http://127.0.0.1:9/none", ...extra });
  test("does nothing without AGENTNET_AGENT, or for root", () => {
    const home = tmp("an-tg-");
    for (let i = 0; i < 6; i++) expect(hook("task-guard.py", { session_id: "s", tool_name: "Read" }, { AGENTNET_HOME: home }).out).toBe("");
    for (let i = 0; i < 6; i++) expect(hook("task-guard.py", { session_id: "s", tool_name: "Read" }, { AGENTNET_HOME: home, AGENTNET_AGENT: "root" }).out).toBe("");
    expect(existsSync(join(home, "state"))).toBe(false);
  });
  test("reminds once after 5 calls with an empty list, then waits 10 minutes", () => {
    const home = tmp("an-tg-");
    for (let i = 0; i < 4; i++) expect(call(home).out).toBe("");
    const r = call(home);
    const j = JSON.parse(r.out);
    expect(j.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(j.hookSpecificOutput.additionalContext).toContain("task list is empty");
    expect(call(home).out).toBe("");
    expect(JSON.parse(readFileSync(join(home, "logs", "task-guard.jsonl"), "utf8").trim())).toMatchObject({ agent: "web-dev-1", reason: "empty" });
  });
  test("a task tool call counts as keeping the list", () => {
    const home = tmp("an-tg-");
    call(home, {}, "mcp__agentnet__task_add");
    for (let i = 0; i < 6; i++) expect(call(home).out).toBe("");
  });
  test("stale: open tasks with no update for 15 minutes", () => {
    const home = tmp("an-tg-");
    call(home, {}, "TodoWrite");
    const sp = join(home, "state", "task-guard", "s-1.json"), st = JSON.parse(readFileSync(sp, "utf8"));
    writeFileSync(sp, JSON.stringify({ ...st, last_update: st.last_update - 1000 }));
    expect(JSON.parse(call(home).out).hookSpecificOutput.additionalContext).toContain("stale");
  });
  test("reads the agent's list from the service", async () => {
    const home = tmp("an-tg-"), tok = join(home, "tok");
    writeFileSync(tok, "t0ken");
    let auth = "";
    const srv = Bun.serve({ port: 0, fetch(req) { auth = req.headers.get("authorization") ?? ""; return Response.json({ agent: { tasks: [{ id: 1, status: "pending" }] } }); } });
    try {
      const env = { AGENTNET_URL: `http://127.0.0.1:${srv.port}/api/v1/agentnet`, AGENTNET_TOKEN_FILE: tok };
      // Bun.spawnSync blocks this thread, so the server cannot answer; run the hook async
      const run = async () => {
        const p = Bun.spawn(["python3", join(REPO, "hooks", "task-guard.py")], { stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s-2", tool_name: "Read" })), stdout: "pipe",
          env: { PATH: process.env.PATH!, AGENTNET_HOME: home, AGENTNET_AGENT: "web-dev-1", ...env } });
        const out = await new Response(p.stdout).text(); await p.exited; return out;
      };
      for (let i = 0; i < 6; i++) expect(await run()).toBe(""); // has a task: not empty, not stale
      expect(auth).toBe("Bearer t0ken");
    } finally { srv.stop(true); }
  });
  test("fails open on bad stdin", () => {
    const r = hook("task-guard.py", "nope", { AGENTNET_AGENT: "x" });
    expect([r.code, r.out]).toEqual([0, ""]);
  });
});

describe("skill-router.py", () => {
  const rules = (home: string, list: unknown[]) => { mkdirSync(join(home, "config"), { recursive: true }); writeFileSync(join(home, "config", "skill-rules.json"), JSON.stringify({ rules: list })); };
  const ctx = (out: string) => JSON.parse(out).hookSpecificOutput.additionalContext as string;
  test("first run writes an empty rules file with an example and prints nothing", () => {
    const r = hook("skill-router.py", { prompt: "please merge these pdf files", session_id: "a" });
    expect([r.code, r.out]).toEqual([0, ""]);
    const f = JSON.parse(readFileSync(join(r.home, "config", "skill-rules.json"), "utf8"));
    expect(f.rules).toEqual([]); expect(f.$example.id).toBe("pdf");
  });
  test("matches keywords and patterns, picks at most 2, best first, and does not repeat in a session", () => {
    const home = tmp("an-sr-");
    rules(home, [
      { id: "pdf", type: "skill", keywords: ["pdf"] },
      { id: "reviewer", type: "agent", keywords: ["review"], patterns: ["\\bPR\\b"] },
      { id: "guide", type: "reference", file: "docs/guide.md", keywords: ["guide"] },
    ]);
    const r = hook("skill-router.py", { prompt: "review this PR and the pdf guide", session_id: "a" }, { AGENTNET_HOME: home });
    const c = ctx(r.out);
    expect(c).toStartWith("[skill-router]");
    expect(c.split("\n").length).toBe(3);
    expect(c.split("\n")[1]).toContain('"reviewer" agent');
    expect(JSON.parse(r.out).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const again = ctx(hook("skill-router.py", { prompt: "review this PR and the pdf guide", session_id: "a" }, { AGENTNET_HOME: home }).out);
    expect(again).toContain("Read docs/guide.md"); expect(again).not.toContain("reviewer");
    expect(ctx(hook("skill-router.py", { prompt: "review this PR please", session_id: "b" }, { AGENTNET_HOME: home }).out)).toContain("reviewer");
  });
  test("skips short prompts, slash commands, no match; fails open on bad rules and bad stdin", () => {
    const home = tmp("an-sr-");
    rules(home, [{ id: "pdf", keywords: ["pdf"] }, { id: "bad", patterns: ["("] }]);
    for (const p of ["pdf", "/pdf merge these", "nothing matches here"]) expect(hook("skill-router.py", { prompt: p }, { AGENTNET_HOME: home }).out).toBe("");
    expect(ctx(hook("skill-router.py", { prompt: "merge pdf files now" }, { AGENTNET_HOME: home }).out)).toContain('skill "pdf"');
    writeFileSync(join(home, "config", "skill-rules.json"), "{ nope");
    expect(hook("skill-router.py", { prompt: "merge pdf files now", session_id: "z" }, { AGENTNET_HOME: home }).out).toBe("");
    expect(hook("skill-router.py", "nope", { AGENTNET_HOME: home }).code).toBe(0);
  });
});

describe("triage.py through claude -p", () => {
  const OK = '{"kind":"feature","route":"team","role":"web-dev","complexity":4,"risk":1,"scope":3,"novelty":2,"specialty":"ui","council":"a,b,c","integrators":"web-dev","reason":"fake"}';
  /** A PATH dir holding a fake `claude` (shell script) plus the system dirs; the real claude is not on it. */
  function fake(body: string) {
    const d = tmp("an-fake-");
    writeFileSync(join(d, "claude"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return `${d}:/usr/bin:/bin`;
  }
  const go = (PATH: string, extra: Record<string, string> = {}) => {
    const home = tmp("an-tr-"), log = join(home, "t.jsonl");
    const r = hook("triage.py", { prompt: "build a settings page for me" }, { AGENTNET_HOME: home, AGENTNET_TRIAGE_LOG: log, AGENTNET_BIN: join(REPO, "bin", "agentnet"), PATH, ...extra });
    return { ...r, rec: existsSync(log) ? JSON.parse(readFileSync(log, "utf8").trim()) : null };
  };
  test("ok: reads the prompt on stdin, passes the isolation flags, prints the [triage] line", () => {
    const args = join(tmp("an-args-"), "args");
    const r = go(fake(`echo "$@" > ${args}; echo "$AGENTNET_TRIAGE_CHILD" >> ${args}; cat >> ${args}; echo '${OK}'`));
    expect(JSON.parse(r.out).hookSpecificOutput.additionalContext).toStartWith("[triage] kind=feature");
    const a = readFileSync(args, "utf8");
    expect(a).toContain("-p --model haiku --strict-mcp-config --setting-sources  --disable-slash-commands --output-format text");
    expect(a).toContain("\n1\nbuild a settings page for me");
    expect(r.rec.route).toBe("team");
  });
  test("not logged in: quiet, skip record", () => {
    const r = go(fake(`echo "Not logged in · Please run /login"; exit 1`));
    expect([r.code, r.out]).toEqual([0, ""]);
    expect([r.rec.skip, r.rec.reason, "p" in r.rec]).toEqual([true, "not_logged_in", false]);
  });
  test("timeout: quiet, skip record, within the budget", () => {
    const t0 = Date.now();
    const r = go(fake("sleep 5"), { AGENTNET_TRIAGE_BUDGET: "1.5" });
    expect([r.code, r.out]).toEqual([0, ""]);
    expect([r.rec.skip, r.rec.reason]).toEqual([true, "timeout"]);
    expect(Date.now() - t0).toBeLessThan(3500);
  });
  test("no claude on PATH: quiet, skip record", () => {
    const r = go("/usr/bin:/bin");
    expect([r.code, r.out]).toEqual([0, ""]);
    expect([r.rec.skip, r.rec.reason]).toEqual([true, "no_claude"]);
  });
  test("AGENTNET_TRIAGE_CHILD=1: does nothing, calls nothing", () => {
    const r = go(fake(`echo '${OK}'`), { AGENTNET_TRIAGE_CHILD: "1" });
    expect([r.code, r.out, r.rec]).toEqual([0, "", null]);
  });
});

describe("no API key anywhere", () => {
  test("git grep finds no Anthropic API key, endpoint or version header outside docs/internal", () => {
    // agentnet runs on the Claude Code subscription only. The pattern is built in parts so this file does not match itself.
    const re = ["ANTHROPIC_API" + "_KEY", "api\\.anthropic" + "\\.com", "anthropic" + "-version"].join("|");
    const p = Bun.spawnSync(["git", "grep", "-nE", re, "--", ".", ":!docs/internal"], { cwd: REPO });
    expect(p.stdout.toString()).toBe("");
  });
});
