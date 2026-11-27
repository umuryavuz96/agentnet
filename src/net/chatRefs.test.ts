import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Hono } from "hono";
import type { Env } from "../core/http";
import { CACHE_MS, chatRefRoutes, checksOf, findRef, knownFolders, refResolver, REF_ID, webBase, type Run, type RunResult } from "./chatRefs";

const dir = mkdtempSync(join(tmpdir(), "chat-ref-"));
const SHA = "839475a1".padEnd(40, "0");
const ok = (out = ""): RunResult => ({ status: 0, out, err: "" });
const fail = (err = "", status = 1): RunResult => ({ status, out: "", err });
/** A fake runner: the answer is picked by the git subcommand or "gh". Every call is kept. */
function fake(over: Partial<Record<string, RunResult>> = {}) {
  const calls: string[][] = [];
  const answers: Record<string, RunResult> = {
    "--git-dir": ok(".git\n"), "--show-toplevel": ok("/somewhere/own-repo\n"), "--verify": ok(SHA + "\n"),
    "-s": ok([SHA, "839475a", "Ada", "2026-11-25T10:00:00+01:00", "feat: chips", "Why it matters.\n"].join("\0")),
    "--numstat": ok("10\t2\tweb/a.ts\0-\t-\tshot.png\0" + "3\t0\tdocs/a b.md\0"),
    "for-each-ref": ok("refs/heads/main\n"), remote: ok(""), ...over as Record<string, RunResult>,
  };
  const run: Run = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "gh") return answers.gh ?? fail();
    const key = ["--git-dir", "--show-toplevel", "--verify", "-s", "--numstat", "for-each-ref", "remote"].find((k) => cmd.includes(k))!;
    return answers[key]!;
  };
  return { run, calls };
}

describe("commit reference", () => {
  test("a local commit: fields, file counts, no remote", async () => {
    const f = fake();
    const r = await refResolver(f.run)(dir, "sha", "839475a");
    expect(r).toMatchObject({ available: true, kind: "sha", repo: "own-repo", commit: { sha: SHA, short: "839475a", subject: "feat: chips", body: "Why it matters.", author: "Ada", branches: ["main"], filesChanged: 3, insertions: 13, deletions: 2, pushed: false, hasRemote: false } });
    if (r.available && r.kind === "sha") expect(r.commit.files).toEqual([{ path: "web/a.ts", add: 10, del: 2 }, { path: "shot.png", add: null, del: null }, { path: "docs/a b.md", add: 3, del: 0 }]);
  });
  test("a commit on a remote branch is pushed; origin/HEAD is not a branch", async () => {
    const f = fake({ "for-each-ref": ok("refs/heads/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\n"), remote: ok("origin\n") });
    expect(await refResolver(f.run)(dir, "sha", "839475a")).toMatchObject({ commit: { pushed: true, hasRemote: true, branches: ["main", "origin/main"] } });
  });
  test("only fixed read-only git commands run, never a shell", async () => {
    const f = fake();
    await refResolver(f.run)(dir, "sha", "839475a");
    for (const c of f.calls) {
      expect(c[0]).toBe("git");
      expect(c.join(" ")).toContain("core.fsmonitor=false");
      expect(c.some((a) => ["fetch", "pull", "push", "checkout", "reset"].includes(a))).toBe(false);
    }
  });
  test("each way it cannot be read says why", async () => {
    expect(await refResolver(fake({ "--git-dir": fail("", 128) }).run)(dir, "sha", "839475a")).toMatchObject({ available: false, reason: "The agent's project folder is not a git repository" });
    expect(await refResolver(fake({ "--verify": fail() }).run)(dir, "sha", "839475a")).toMatchObject({ available: false, reason: "No such commit in the agent's project folder" });
    expect(await refResolver(fake({ "--git-dir": fail("", 127) }).run)(dir, "sha", "839475a")).toMatchObject({ available: false, reason: "git is not installed" });
    expect(await refResolver(fake().run)(null, "sha", "839475a")).toMatchObject({ available: false, reason: "This agent has no project folder" });
    expect(await refResolver(fake().run)(join(dir, "gone"), "sha", "839475a")).toMatchObject({ available: false, reason: "The agent's project folder is gone" });
  });
});

describe("pull request reference", () => {
  const gh = (o: object = {}) => ok(JSON.stringify({ number: 12, title: "Chips", state: "OPEN", isDraft: false, url: "https://github.com/o/r/pull/12", author: { login: "ada" }, headRefName: "feat/chips", baseRefName: "main", statusCheckRollup: [], ...o }));
  const pr = (over: Partial<Record<string, RunResult>>) => refResolver(fake({ remote: ok("origin\n"), ...over }).run)(dir, "pr", "12");
  test("open, draft, merged and closed", async () => {
    expect(await pr({ gh: gh() })).toMatchObject({ available: true, pr: { number: 12, state: "open", author: "ada", branch: "feat/chips", base: "main" } });
    expect(await pr({ gh: gh({ isDraft: true }) })).toMatchObject({ pr: { state: "draft" } });
    expect(await pr({ gh: gh({ state: "MERGED" }) })).toMatchObject({ pr: { state: "merged" } });
    expect(await pr({ gh: gh({ state: "CLOSED", isDraft: true }) })).toMatchObject({ pr: { state: "closed" } });
  });
  test("checks are counted from check runs and commit statuses", () => {
    expect(checksOf([
      { status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }, { status: "IN_PROGRESS", conclusion: "" },
      { status: "COMPLETED", conclusion: "SKIPPED" }, { state: "SUCCESS" }, { state: "ERROR" }, { state: "PENDING" },
    ])).toEqual({ total: 7, passed: 2, failed: 2, pending: 2, skipped: 1 });
    expect(checksOf(null)).toEqual({ total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 });
  });
  test("no remote, no gh, not found, not signed in, odd output", async () => {
    expect(await pr({ remote: ok("") })).toMatchObject({ available: false, reason: "This repository has no remote" });
    expect(await pr({ gh: fail("", 127) })).toMatchObject({ reason: "The GitHub CLI (gh) is not installed" });
    expect(await pr({ gh: fail("GraphQL: Could not resolve to a PullRequest with the number of 12.") })).toMatchObject({ reason: "No such pull request in this repository" });
    expect(await pr({ gh: fail("To get started with GitHub CLI, please run:  gh auth login") })).toMatchObject({ reason: "The GitHub CLI (gh) is not signed in" });
    expect(await pr({ gh: ok("not json") })).toMatchObject({ available: false });
    expect(await pr({ gh: gh({ url: "javascript:alert(1)" }) })).toMatchObject({ available: false });
  });
});

describe("cache", () => {
  test("one run for 60 s, shared by callers; a new one after", async () => {
    let t = 1000;
    const f = fake(), resolve = refResolver(f.run, () => t);
    await Promise.all([resolve(dir, "sha", "839475a"), resolve(dir, "sha", "839475a")]);
    const first = f.calls.length;
    t += CACHE_MS - 1; await resolve(dir, "sha", "839475a");
    expect(f.calls.length).toBe(first);
    t += 2; await resolve(dir, "sha", "839475a");
    expect(f.calls.length).toBe(first * 2);
  });
});

describe("other repositories", () => {
  const folder = (n: string) => { const d = join(dir, n); mkdirSync(d, { recursive: true }); return d; };
  const own = folder("own"), plain = folder("plain"), has = folder("has"), also = folder("also");
  /** Each folder is its own fake repository; `plain` is not one; only the named ones hold the commit or the pull request. */
  function world(holders: string[], over: (cwd: string, cmd: string[]) => RunResult | undefined = () => undefined) {
    const asked: string[] = [];
    const run: Run = async (cmd, cwd) => {
      const o = over(cwd, cmd); if (o) return o;
      if (cmd.includes("--git-dir")) { asked.push(basename(cwd)); return cwd === plain ? fail("", 128) : ok(".git\n"); }
      if (cmd[0] === "gh") return holders.includes(cwd) ? ok(JSON.stringify({ number: 12, title: "T", state: "OPEN", url: "https://github.com/o/r/pull/12" })) : fail("Could not resolve to a PullRequest");
      if (cmd.includes("--show-toplevel")) return ok(cwd + "\n");
      if (cmd.includes("--verify")) return holders.includes(cwd) ? ok(SHA + "\n") : fail();
      if (cmd.includes("remote")) return ok("origin\n");
      return fake().run(cmd, cwd);
    };
    return { asked, resolve: refResolver(run) };
  }
  test("the first repository that has it wins and is named; folders that are no repository are passed over", async () => {
    const w = world([has, also]);
    const r = await findRef(w.resolve, own, () => [plain, join(dir, "gone"), own, has, also], "sha", "839475a");
    expect(r).toMatchObject({ available: true, repo: "has" });
    expect(w.asked).toEqual(["own", "plain", "has"]);
  });
  test("the agent's own repository answers without a look at the others", async () => {
    const w = world([own, has]);
    let listed = 0;
    expect(await findRef(w.resolve, own, () => (listed++, [has]), "sha", "839475a")).toMatchObject({ repo: "own" });
    expect(listed).toBe(0);
  });
  test("no project folder, or one that is no repository, still looks elsewhere", async () => {
    expect(await findRef(world([has]).resolve, null, () => [has], "sha", "839475a")).toMatchObject({ repo: "has" });
    expect(await findRef(world([has]).resolve, plain, () => [has], "sha", "839475a")).toMatchObject({ repo: "has" });
  });
  test("nowhere: the reason says that other repositories were searched; with none to search it keeps its own", async () => {
    expect(await findRef(world([]).resolve, own, () => [has], "sha", "839475a")).toMatchObject({ available: false, reason: "No such commit in the agent's project folder or the other known repositories" });
    expect(await findRef(world([]).resolve, own, () => [plain], "sha", "839475a")).toMatchObject({ reason: "No such commit in the agent's project folder" });
    expect(await findRef(world([]).resolve, own, () => [has], "pr", "12")).toMatchObject({ reason: "No such pull request in the agent's project folder or the other known repositories" });
    expect(await findRef(world([]).resolve, null, () => [], "sha", "839475a")).toMatchObject({ reason: "This agent has no project folder" });
  });
  test("a pull request is found the same way; gh missing stops the search", async () => {
    expect(await findRef(world([has]).resolve, own, () => [has], "pr", "12")).toMatchObject({ available: true, repo: "has", pr: { number: 12 } });
    const w = world([has], (_, cmd) => (cmd[0] === "gh" ? fail("", 127) : undefined));
    expect(await findRef(w.resolve, own, () => [has], "pr", "12")).toMatchObject({ reason: "The GitHub CLI (gh) is not installed" });
    expect(w.asked).not.toContain("has");
  });
  test("only git and gh read commands run in the other folders", async () => {
    const seen: string[][] = [];
    const w = world([has], (_, cmd) => { seen.push(cmd); return undefined; });
    await findRef(w.resolve, own, () => [plain, has], "sha", "839475a");
    expect(seen.every((c) => c[0] === "git" && !c.some((a) => ["fetch", "pull", "push", "checkout", "reset"].includes(a)))).toBe(true);
  });
});

describe("known folders", () => {
  const agents = () => [{ spawnedAt: 1, project: "/old" }, { spawnedAt: 3, project: "/new" }, { spawnedAt: 2, project: null }] as unknown as ReturnType<typeof import("./store").all>;
  test("the folder the agent's terminal stands in comes first, then the agents' project folders, newest first", () => {
    const asked: string[][] = [];
    const tmux = { run: (a: string[]) => (asked.push(a), { code: 0, out: "/here\n" }) };
    expect(knownFolders("ada", tmux, agents)).toEqual(["/here", "/new", "/old"]);
    expect(asked.map((a) => a[0])).toEqual(["has-session", "display-message"]);
  });
  test("without a terminal only the project folders are known", () => {
    expect(knownFolders("ada", { run: () => ({ code: 127, out: "" }) }, agents)).toEqual(["/new", "/old"]);
  });
});

describe("route", () => {
  const f = fake();
  const app = new Hono<Env>();
  chatRefRoutes(app, refResolver(f.run), (n) => (n === "ada" ? dir : null), () => []);
  test("answers 200 for a good question, also when nothing is available", async () => {
    const r = await app.request("/agentnet/agents/ada/ref?kind=sha&id=839475a");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ available: true, id: "839475a" });
    const n = await app.request("/agentnet/agents/bob/ref?kind=pr&id=3");
    expect(n.status).toBe(200);
    expect(await n.json()).toMatchObject({ available: false, reason: "This agent has no project folder" });
  });
  test("a bad kind or id is refused before anything runs", async () => {
    const before = f.calls.length;
    for (const q of ["kind=sha&id=HEAD", "kind=sha&id=--output=x", "kind=sha&id=abc", "kind=sha&id=839475a%3Bls", "kind=pr&id=0", "kind=pr&id=-R", "kind=pr&id=1234567", "kind=tag&id=1", ""])
      expect((await app.request("/agentnet/agents/ada/ref?" + q)).status).toBe(422);
    expect((await app.request("/agentnet/agents/Bad_Name!/ref?kind=pr&id=1")).status).toBe(422);
    expect(f.calls.length).toBe(before);
  });
});

describe("branch reference", () => {
  const real = async (cwd: string, ...a: string[]) => { expect(await Bun.spawn(["git", "-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...a], { cwd, stdout: "ignore", stderr: "ignore" }).exited).toBe(0); };
  test("ahead, behind and the latest commit against main, from a real repository", async () => {
    const d = mkdtempSync(join(tmpdir(), "chat-ref-branch-"));
    await real(d, "init", "-q", "-b", "main");
    await real(d, "commit", "-q", "--allow-empty", "-m", "start");
    await real(d, "checkout", "-q", "-b", "feat/chips");
    await real(d, "commit", "-q", "--allow-empty", "-m", "feat: chips");
    await real(d, "commit", "-q", "--allow-empty", "-m", "feat: hover");
    await real(d, "checkout", "-q", "main");
    await real(d, "commit", "-q", "--allow-empty", "-m", "fix: other");
    const r = await refResolver()(d, "branch", "feat/chips");
    expect(r).toMatchObject({ available: true, kind: "branch", branch: { name: "feat/chips", base: "main", ahead: 2, behind: 1, latest: { author: "Ada", subject: "feat: hover" } } });
    if (r.available && r.kind === "branch") expect(r.branch.url).toBeUndefined();
    expect(await refResolver()(d, "branch", "feat/none")).toMatchObject({ available: false, reason: "No such branch in the agent's project folder" });
  });
  test("a branch name can never be an option or a range", () => {
    for (const bad of ["-x", "--all", "a..b", "a b", "a;b", "a/"]) expect(REF_ID.branch.test(bad)).toBe(false);
    for (const good of ["main", "feat/chat-shell", "v1.2/x"]) expect(REF_ID.branch.test(good)).toBe(true);
  });
  test("a web address comes only from a GitHub remote and drops its login", () => {
    expect(webBase("git@github.com:o/r.git\n")).toBe("https://github.com/o/r");
    expect(webBase("https://user:secret@github.com/o/r.git")).toBe("https://github.com/o/r");
    expect(webBase("ssh://git@github.com/o/r")).toBe("https://github.com/o/r");
    for (const other of ["https://gitlab.com/o/r.git", "https://github.com.evil.dev/o/r", "/tmp/r", ""]) expect(webBase(other)).toBeNull();
  });
});

test("kind=msg: an unknown message is not available, a bad id is 422", async () => {
  const app = new Hono<Env>();
  chatRefRoutes(app, refResolver(fake().run), () => null, () => []);
  const r = await app.request("/agentnet/agents/ada/ref?kind=msg&id=999999999");
  expect(await r.json()).toMatchObject({ available: false, kind: "msg", id: "999999999" });
  expect((await app.request("/agentnet/agents/ada/ref?kind=msg&id=abc")).status).toBe(422);
});
