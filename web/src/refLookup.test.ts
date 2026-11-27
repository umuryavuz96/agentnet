import { describe, expect, test } from "bun:test";
import { checksLine, knownRef, loadRef, messageTarget, planTarget, stateChips, type RefAnswer } from "./refLookup";
import { refChip } from "./chatMarkers";
import { agentnetFeed } from "./agentnetRows";
import type { Job } from "./net";

const commit = (pushed: boolean, hasRemote = pushed): RefAnswer => ({ available: true, kind: "sha", id: "839475a", repo: "r", commit: { sha: "839475a", short: "839475a", subject: "s", body: "", author: "a", date: "", branches: [], files: [], filesChanged: 0, insertions: 0, deletions: 0, pushed, hasRemote } });
const pr = (state: "open" | "merged" | "closed" | "draft", failed = 0): RefAnswer => ({ available: true, kind: "pr", id: "12", pr: { number: 12, title: "t", state, author: "a", branch: "b", base: "main", url: "https://github.com/o/r/pull/12", checks: { total: 3, passed: 3 - failed, failed, pending: 0, skipped: 0 } } });

describe("reference chips name their target", () => {
  test("data-ref and data-id carry the bare id; a file chip keeps only its path", () => {
    for (const [kind, text, id] of [["msg", "#8931", "8931"], ["step", "step 1.2", "1.2"], ["job", "job 14", "14"], ["pr", "PR #12", "12"], ["sha", "839475a", "839475a"]] as const)
      expect(refChip(kind, text)).toContain(`data-ref="${kind}" data-id="${id}"`);
    expect(refChip("file", "a.ts", ' data-path="a.ts"')).not.toContain("data-ref");
  });
});

describe("state chips", () => {
  test("tones follow the state", () => {
    expect(stateChips(commit(true))).toEqual([{ tone: "ok", text: "pushed" }]);
    expect(stateChips(commit(false))).toEqual([{ tone: "warn", text: "local only" }]);
    expect(stateChips(commit(false, true))).toEqual([{ tone: "warn", text: "not pushed" }]);
    expect((["merged", "open", "draft", "closed"] as const).map((s) => stateChips(pr(s))[0]!.tone)).toEqual(["ok", "info", "warn", "bad"]);
    expect(stateChips(pr("open", 2))[1]).toEqual({ tone: "bad", text: "2 checks failed" });
    expect(stateChips({ available: false, kind: "pr", id: "1", reason: "x" })).toEqual([]);
  });
  test("checks line", () => {
    expect(checksLine({ total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 })).toBe("No checks");
    expect(checksLine({ total: 4, passed: 2, failed: 1, pending: 1, skipped: 0 })).toBe("2 passed · 1 failed · 1 running");
  });
});

describe("lookup", () => {
  test("one request for the same reference, answer kept", async () => {
    let n = 0;
    const get = async (path: string) => { n++; expect(path).toBe("v1/panel/agents/ada/ref?kind=sha&id=839475a"); return commit(true); };
    await Promise.all([loadRef("ada", "sha", "839475a", get), loadRef("ada", "sha", "839475a", get)]);
    expect(n).toBe(1);
    expect(knownRef("ada", "sha", "839475a")).toMatchObject({ available: true });
  });
  test("a failed request says why and is asked again", async () => {
    const down = async (): Promise<RefAnswer> => { throw new Error("no such route"); };
    expect(await loadRef("ada", "pr", "5", down)).toMatchObject({ available: false, reason: expect.stringContaining("Restart") });
    expect(knownRef("ada", "pr", "5")).toBeUndefined();
    expect(await loadRef("ada", "pr", "5", async () => pr("open"))).toMatchObject({ available: true });
  });
});

describe("plan and message targets", () => {
  const jobs = [{ id: 7, steps: [{ n: 1 }, { n: 2 }] }, { id: 9, steps: [{ n: 1 }] }] as unknown as Job[];
  test("step 2 is a step of the current job; 7.2 names its job; a missing one stays plain", () => {
    expect(planTarget(jobs, "step", "1")).toEqual({ job: 9, step: 1 });
    expect(planTarget(jobs, "step", "7.2")).toEqual({ job: 7, step: 2 });
    expect(planTarget(jobs, "job", "7")).toEqual({ job: 7, step: null });
    expect(planTarget(jobs, "step", "2")).toBeNull();
    expect(planTarget(jobs, "job", "14")).toBeNull();
    expect(planTarget(undefined, "step", "1")).toBeNull();
  });
  test("a delivered message and a sent one both lead to their trail row", () => {
    const feed = agentnetFeed(
      [{ id: 52, from: "ada", to: "root", kind: "report", body: "b", at: 1500 }],
      [{ id: "s1", ts: 1000, kind: "step", title: "agentnet · send", status: "ok", tool: "agentnet", out: "sent #52" }, { id: "d1", ts: 2000, kind: "delivery", msg: 41 }],
      "all", "ada");
    const works = [{ key: "w1", items: feed }];
    expect(messageTarget(works, 41)).toEqual({ key: "w1", item: "d1" });
    expect(messageTarget(works, 52)?.key).toBe("w1");
    expect(messageTarget(works, 99)).toBeNull();
  });
});
