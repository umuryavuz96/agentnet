import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixture, sh } from "../../test/updateFixture";
import { acquire, readLock, release } from "./lock";
import { preflight } from "./preflight";
import { headCommit } from "./git";

const opts = (f: { home: string }) => ({ home: f.home, allowLocalOrigin: true });
const reason = (r: ReturnType<typeof preflight>) => (r.ok ? "ok" : r.reason);

describe("preflight refusals (T3)", () => {
  test("ok with a target", () => {
    const f = makeFixture();
    const r = preflight(f.work, opts(f));
    expect(r.ok && r.current.tag).toBe("v0.3.0");
    expect(r.ok && r.target?.tag).toBe("v0.4.0");
  });
  test("not-git", () => {
    const d = mkdtempSync(join(tmpdir(), "an-nogit-"));
    expect(reason(preflight(d))).toBe("not-git");
  });
  test("no-origin", () => {
    const f = makeFixture();
    sh(f.work, "remote", "remove", "origin");
    expect(reason(preflight(f.work, opts(f)))).toBe("no-origin");
  });
  test("origin-mismatch: other github repo, and file:// without the test flag", () => {
    const f = makeFixture();
    expect(reason(preflight(f.work, { home: f.home }))).toBe("origin-mismatch");
    sh(f.work, "remote", "set-url", "origin", "https://github.com/evil/agentnet.git");
    const r = preflight(f.work, opts(f));
    expect(reason(r)).toBe("origin-mismatch");
    expect(!r.ok && r.hint).toContain("evil/agentnet");
  });
  test("origin matches over https, ssh, with and without .git", () => {
    const f = makeFixture();
    for (const u of ["https://github.com/umuryavuz96/agentnet", "git@github.com:umuryavuz96/agentnet.git", "https://github.com/UmurYavuz96/agentnet.git"]) {
      sh(f.work, "remote", "set-url", "origin", u);
      // fetch fails (no network to github in tests is not guaranteed), but the mismatch gate must be passed
      expect(reason(preflight(f.work, { home: f.home, fetch: false }))).toBe("ok");
    }
  });
  test("insteadOf: the slug check sees the configured URL, fetch follows the owner's own mirror rule", () => {
    const f = makeFixture();
    sh(f.work, "remote", "set-url", "origin", "https://github.com/umuryavuz96/agentnet.git");
    sh(f.work, "config", `url.${f.origin}.insteadOf`, "https://github.com/umuryavuz96/agentnet.git");
    const r = preflight(f.work, { home: f.home }); // no allowLocalOrigin: a real github.com URL, fetched from the local bare repo
    expect(r.ok && r.target?.tag).toBe("v0.4.0");
    // the reverse does not help: a local path origin is still a mismatch, whatever insteadOf says
    const g = makeFixture();
    sh(g.work, "config", "url.https://github.com/umuryavuz96/agentnet.git.insteadOf", g.origin);
    expect(reason(preflight(g.work, { home: g.home }))).toBe("origin-mismatch");
  });
  test("AGENTNET_UPDATE_REPO names the repository", () => {
    const f = makeFixture();
    sh(f.work, "remote", "set-url", "origin", "https://github.com/me/fork.git");
    expect(reason(preflight(f.work, { home: f.home, fetch: false }))).toBe("origin-mismatch");
    process.env.AGENTNET_UPDATE_REPO = "me/fork";
    try { expect(reason(preflight(f.work, { home: f.home, fetch: false }))).toBe("ok"); } finally { delete process.env.AGENTNET_UPDATE_REPO; }
  });
  test("dirty: tracked change blocks, untracked file does not", () => {
    const f = makeFixture();
    writeFileSync(join(f.work, "stray.txt"), "x");
    expect(reason(preflight(f.work, opts(f)))).toBe("ok");
    writeFileSync(join(f.work, "CHANGELOG.md"), "edited");
    expect(reason(preflight(f.work, opts(f)))).toBe("dirty");
  });
  test("branch: other branch refused, AGENTNET_UPDATE_BRANCH allows it, detached on a release tag allowed", () => {
    const f = makeFixture();
    sh(f.work, "checkout", "-b", "feature");
    expect(reason(preflight(f.work, opts(f)))).toBe("branch");
    process.env.AGENTNET_UPDATE_BRANCH = "feature";
    try { expect(reason(preflight(f.work, opts(f)))).toBe("ok"); } finally { delete process.env.AGENTNET_UPDATE_BRANCH; }
    sh(f.work, "checkout", "main");
    sh(f.work, "checkout", "--detach", "v0.3.0");
    expect(reason(preflight(f.work, opts(f)))).toBe("ok");
    sh(f.work, "commit", "--allow-empty", "-m", "off tag");
    expect(reason(preflight(f.work, opts(f)))).toBe("branch");
  });
  test("diverged: a local commit that is not in the target", () => {
    const f = makeFixture();
    sh(f.work, "commit", "--allow-empty", "-m", "local only");
    const r = preflight(f.work, opts(f));
    expect(reason(r)).toBe("diverged");
    expect(!r.ok && r.hint).toContain("v0.4.0");
  });
  test("local-only tags are never a target", () => {
    const f = makeFixture();
    sh(f.work, "tag", "v9.9.9");
    const r = preflight(f.work, opts(f));
    expect(r.ok && r.target?.tag).toBe("v0.4.0");
  });
  test("tag-moved: local tag differs from origin", () => {
    const f = makeFixture();
    sh(f.work, "tag", "v0.4.0"); // points at HEAD (v0.3.0), origin's points elsewhere
    const r = preflight(f.work, opts(f));
    expect(reason(r)).toBe("tag-moved");
    expect(!r.ok && r.hint).toContain("Delete the local tag");
  });
  test("fetches only the target tag", () => {
    const f = makeFixture();
    expect(sh(f.work, "tag", "--list", "v*")).toBe("v0.3.0");
    preflight(f.work, opts(f));
    expect(sh(f.work, "tag", "--list", "v*").split("\n").sort()).toEqual(["v0.3.0", "v0.4.0"]);
  });
  test("fetch: origin unreachable", () => {
    const f = makeFixture();
    sh(f.work, "remote", "set-url", "origin", join(f.dir, "gone.git"));
    expect(reason(preflight(f.work, opts(f)))).toBe("fetch");
  });
  test("locked: live pid refuses, dead pid is stale", () => {
    const f = makeFixture();
    expect(acquire(f.home, "upd-1")).not.toBeNull();
    const r = preflight(f.work, opts(f));
    expect(reason(r)).toBe("locked");
    expect(!r.ok && r.hint).toContain("upd-1");
    release(f.home, "upd-1");
    mkdirSync(join(f.home, "run"), { recursive: true });
    writeFileSync(join(f.home, "run", "update.lock"), JSON.stringify({ id: "upd-0", pid: 2 ** 22 + 12345, startedAt: 1 }));
    expect(readLock(f.home)).toBeNull();
    expect(reason(preflight(f.work, opts(f)))).toBe("ok");
    expect(acquire(f.home, "upd-2")?.id).toBe("upd-2");
  });
  test("does not move HEAD", () => {
    const f = makeFixture();
    const before = headCommit(f.work);
    preflight(f.work, opts(f));
    expect(headCommit(f.work)).toBe(before);
    rmSync(f.dir, { recursive: true, force: true });
  });
});

describe("preflight current (T4)", () => {
  test("on newest: ok, target null", () => {
    const f = makeFixture();
    sh(f.work, "pull", "--ff-only", "origin", "main");
    const r = preflight(f.work, opts(f));
    expect(r.ok && r.target).toBeNull();
  });
  test("fetch:false skips the network and the target", () => {
    const f = makeFixture();
    sh(f.work, "remote", "set-url", "origin", join(f.dir, "gone.git"));
    const r = preflight(f.work, { ...opts(f), fetch: false });
    expect(r.ok && r.target).toBeNull();
  });
});
