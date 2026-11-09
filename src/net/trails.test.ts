import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "sd-trails-"));
process.env.AGENTNET_HOME ??= home;
const { Database } = await import("bun:sqlite");
const { ROOT } = await import("../core/config");
const tr = await import("./trails");

const repo = join(ROOT, "repo");
beforeAll(() => {
  mkdirSync(join(repo, "server"), { recursive: true });
  writeFileSync(join(repo, "server", "usage.ts"), "x");
  mkdirSync(join(ROOT, "config"), { recursive: true });
  writeFileSync(join(ROOT, "config", "trails.json"), JSON.stringify({ repos: [] }));
  tr.useTrailDb(new Database(":memory:"));
});

describe("trails", () => {
  test("terms drop stop words, numbers and short words", () => {
    expect(tr.terms("Fix the usage breakdown on the Agents page, task 12")).toEqual(["fix", "usage", "breakdown", "agents", "page", "task"]); // "agent", "task" carry meaning in this corpus
  });

  test("a decision note is written, indexed and found; missing files are hidden", () => {
    const f = tr.writeNote({ agent: "backend-1", task: "Usage breakdown per agent", repo }, {
      goal: "show who used the tokens", decisions: [{ chosen: "fold small agents into Other", rejected: "a long list", why: "readable" }],
      files: ["server/usage.ts", "server/gone.ts"], gotchas: "usage events arrive late", result: "shipped",
    });
    const md = readFileSync(f, "utf8");
    expect(md).toContain("## Decisions\n- chose fold small agents into Other over a long list because readable");
    expect(tr.parseNote(md).files).toEqual(["server/usage.ts", "server/gone.ts"]);
    const hits = tr.search("usage breakdown agents page");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("note");
    expect(hits[0]!.files).toEqual(["server/usage.ts"]); // gone.ts no longer exists
    const text = tr.format(hits);
    expect(text).toStartWith("Past trails (may be stale, verify):");
    expect(text.length).toBeLessThanOrEqual(1500);
  });

  test("a hit whose files are all gone is hidden", () => {
    tr.writeNote({ agent: "web-dev-1", task: "Kiosk ribbon colours", repo }, { files: ["web/nope.vue"], result: "ribbon done" });
    expect(tr.search("kiosk ribbon")).toHaveLength(0);
  });

  test("limit caps at 3 for agents, max lifts it for the UI", () => {
    for (let i = 0; i < 5; i++) tr.writeNote({ agent: "qa-1", task: `Probe flakiness round ${i}`, repo }, { goal: "probe flakiness" });
    expect(tr.search("probe flakiness", { limit: 10 })).toHaveLength(3);
    expect(tr.search("probe flakiness", { limit: 10, max: 20 })).toHaveLength(5);
  });

  test("inject: threshold, off switch, control agents, and a log line per call", async () => {
    expect((await tr.inject("sre-1", "task_add", "probe flakiness again")).hits.length).toBeGreaterThan(0);
    expect((await tr.inject("sre-1", "task_add", "probe something")).skipped).toBe("no hit above threshold"); // one term only
    writeFileSync(join(ROOT, "config", "trails.json"), JSON.stringify({ repos: [], off_agents: ["sre-2"] }));
    expect((await tr.inject("sre-2", "task_add", "probe flakiness")).skipped).toBe("control");
    process.env.AGENTNET_TRAIL_INJECT = "0";
    expect((await tr.inject("sre-1", "task_add", "probe flakiness")).skipped).toBe("off");
    delete process.env.AGENTNET_TRAIL_INJECT;
    expect(existsSync(tr.injectLog())).toBe(true);
    const lines = readFileSync(tr.injectLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ agent: "sre-1", source: "task_add", skipped: "off" });
  });
});

describe("cleanPrompt", () => {
  test("drops agentnet boilerplate, keeps delivery subjects and the brief", () => {
    const p = 'You are web-dev-1 on the agentnet (boss: root). Use the agentnet tools.\n#123 [task] root: "Build the Search tab"\nUse the route. PRIORITY RULE: task management comes first.\nMake it fast.';
    expect(tr.cleanPrompt(p)).toBe("Build the Search tab\nMake it fast.");
    expect(tr.cleanPrompt("You are backend-1. Boss: root. Job: give agents a trail memory.")).toBe("give agents a trail memory.");
  });
});

describe("inject skips the agent's own current work", () => {
  test("a note from this spawn is not injected back to its author; another agent gets it", async () => {
    writeFileSync(join(ROOT, "config", "trails.json"), JSON.stringify({ repos: [] }));
    tr.writeNote({ agent: "ops-7", task: "Rotate grafana dashboards backup", repo }, { goal: "grafana dashboards backup rotation" });
    expect((await tr.inject("ops-7", "task_msg", "grafana dashboards backup", undefined, undefined, undefined, Date.now() - 1000)).hits).toHaveLength(0);
    expect((await tr.inject("ops-8", "task_msg", "grafana dashboards backup", undefined, undefined, undefined, Date.now() - 1000)).hits).toHaveLength(1);
  });
});

describe("git history and attribution", () => {
  test("commits are indexed with their subject as title; the resolver names the agent", async () => {
    const g = join(ROOT, "gitrepo"); mkdirSync(join(g, "web"), { recursive: true });
    const run = (...a: string[]) => Bun.spawnSync(["git", "-C", g, ...a], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    run("init", "-q", "-b", "main"); writeFileSync(join(g, "web", "clock.vue"), "x"); run("add", "."); run("commit", "-q", "-m", "feat(web): kiosk clock widget\n\nRefresh aligned to the minute.\n\nCo-Authored-By: X <x@x>");
    writeFileSync(join(ROOT, "config", "trails.json"), JSON.stringify({ repos: [g] }));
    tr.useTrailDb(new Database(":memory:"));
    tr.reindex({ session: () => "", commit: (_r, _at, files) => (files.includes("web/clock.vue") ? "web-dev-9" : "") }, true);
    const h = tr.search("kiosk clock minute");
    expect(h[0]).toMatchObject({ kind: "commit", title: "feat(web): kiosk clock widget", agent: "web-dev-9", files: ["web/clock.vue"] });
    expect(h[0]!.snippet).not.toContain("Co-Authored-By");
  });
});
