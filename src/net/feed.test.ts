import { describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "feed-"));
process.env.AGENTNET_CLAUDE_HOME = home;
const { FeedParser, Sent, stepTitle, transcriptFor, projectDir } = await import("./feed");
const fx = join(import.meta.dir, "fixtures", "feed-session.jsonl");
const none = () => null;

describe("parser", () => {
  const p = new FeedParser(fx, "a", none, 0); p.update();
  const by = (id: string) => p.get(id)!;
  test("owner prompt, assistant text (redacted), no thinking", () => {
    expect(by("u1")).toMatchObject({ kind: "owner", text: "Please run the tests" });
    expect(by("a1:1").text).not.toContain("sk-abcdef");
    expect(p.items.some((i) => i.text?.includes("secret thoughts"))).toBe(false);
  });
  test("tool calls get plain titles and a result", () => {
    expect(by("t1")).toMatchObject({ kind: "step", title: "Running tests", status: "ok" });
    expect(by("t1").out).toContain("358 pass");
    expect(by("t2")).toMatchObject({ title: "Editing App.vue", status: "error" });
    expect(by("t3")).toMatchObject({ title: "Reading z.ts", status: "running" });
  });
  test("agentnet delivery collapses to one row; meta, reminders and sidechain are dropped", () => {
    expect(by("u4")).toMatchObject({ kind: "delivery", msg: 1077 });
    expect(p.get("u3")).toBeUndefined(); expect(p.get("u5")).toBeUndefined(); expect(p.get("sc1:0")).toBeUndefined();
  });
  test("compaction event", () => expect(by("s1")).toMatchObject({ kind: "event", text: "Compacted" }));
  test("interrupt closes running steps", () => {
    const f = join(home, "i.jsonl"); writeFileSync(f, "");
    const q = new FeedParser(f, "a", none, 0);
    appendFileSync(f, JSON.stringify({ type: "assistant", uuid: "x", timestamp: "2026-11-10T10:00:00Z", message: { content: [{ type: "tool_use", id: "k", name: "Bash", input: { command: "sleep 9" } }] } }) + "\n"); q.update();
    appendFileSync(f, JSON.stringify({ type: "user", uuid: "y", timestamp: "2026-11-10T10:00:03Z", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }) + "\n"); q.update();
    expect(q.get("k")).toMatchObject({ status: "error", out: "Interrupted" });
    expect(q.items.at(-1)).toMatchObject({ kind: "event", text: "Interrupted" });
  });
  test("long tool output is cut to 2 kB", () => {
    const f = join(home, "l.jsonl"); writeFileSync(f, "");
    const q = new FeedParser(f, "a", none, 0);
    appendFileSync(f, JSON.stringify({ type: "assistant", uuid: "x", timestamp: "2026-11-10T10:00:00Z", message: { content: [{ type: "tool_use", id: "k", name: "Bash", input: { command: "ls" } }] } }) + "\n");
    appendFileSync(f, JSON.stringify({ type: "user", uuid: "y", timestamp: "2026-11-10T10:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "k", content: "z ".repeat(5000) }] } }) + "\n"); q.update();
    expect(q.get("k")!.out!.length).toBeLessThanOrEqual(2001);
  });
});

describe("incremental diff", () => {
  test("only new/changed items after a cursor; a half line waits", () => {
    const f = join(home, "d.jsonl"); copyFileSync(fx, f);
    const p = new FeedParser(f, "a", none, 0); p.update();
    const c0 = p.cursor;
    expect(p.changedSince(c0).items).toEqual([]);
    const line = JSON.stringify({ type: "user", uuid: "n1", timestamp: "2026-11-10T11:00:00Z", origin: { kind: "human" }, message: { content: "hello" } });
    appendFileSync(f, line.slice(0, 20)); p.update(); expect(p.changedSince(c0).items).toEqual([]);
    appendFileSync(f, line.slice(20) + "\n"); p.update();
    expect(p.changedSince(c0).items.map((i) => i.id)).toEqual(["n1"]);
    appendFileSync(f, JSON.stringify({ type: "user", uuid: "n2", timestamp: "2026-11-10T11:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "ok" }] } }) + "\n"); p.update();
    expect(p.changedSince(c0).items.map((i) => i.id)).toEqual(["n1", "t3"]); // t3 changed from running to ok
  });
  test("tail starts mid-file without a broken first line", () => {
    const p = new FeedParser(fx, "a", none, 600); p.update();
    expect(p.items.length).toBeGreaterThan(0); expect(p.items.length).toBeLessThan(8);
  });
});

describe("dedupe of typed prompts", () => {
  test("a transcript line claims its nonce once; the same text twice is two entries", () => {
    const s = new Sent(); const t0 = Date.parse("2026-11-10T10:00:00Z");
    s.add("a", "hello  there", "n1", t0); s.add("a", "hello there", "n2", t0 + 1000);
    expect(s.pending("a", t0 + 2000)).toHaveLength(2);
    expect(s.claim("a", "hello there", t0 + 500)).toEqual({ nonce: "n1" });
    expect(s.claim("a", "hello there", t0 + 1500)).toEqual({ nonce: "n2" });
    expect(s.claim("a", "hello there", t0 + 2000)).toBeNull();
  });
  test("the owner item carries the nonce of its send", () => {
    const f = join(home, "n.jsonl"); writeFileSync(f, JSON.stringify({ type: "user", uuid: "m1", timestamp: "2026-11-10T10:00:01Z", origin: { kind: "human" }, message: { content: "do it" } }) + "\n");
    const s = new Sent(); s.add("a", "do it", "nx", Date.parse("2026-11-10T10:00:00Z"));
    const p = new FeedParser(f, "a", (a, t, ts) => s.claim(a, t, ts), 0); p.update();
    expect(p.get("m1")).toMatchObject({ kind: "owner", nonce: "nx" });
  });
});

describe("transcript path", () => {
  const cwd = "/Users/x/my.proj", dir = projectDir(cwd);
  mkdirSync(dir, { recursive: true });
  test("slug rule: every non-alphanumeric becomes a dash", () => expect(dir.endsWith("-Users-x-my-proj")).toBe(true));
  test("session wins, then the pid file, then the newest jsonl", () => {
    writeFileSync(join(dir, "s1.jsonl"), "{}\n"); writeFileSync(join(dir, "s2.jsonl"), "{}\n");
    expect(transcriptFor({ session: "s1", project: cwd, pid: null })).toBe(join(dir, "s1.jsonl"));
    mkdirSync(join(home, "sessions"), { recursive: true }); writeFileSync(join(home, "sessions", "77.json"), JSON.stringify({ sessionId: "s2", cwd }));
    expect(transcriptFor({ session: "gone", project: cwd, pid: 77 })).toBe(join(dir, "s2.jsonl"));
    expect(transcriptFor({ session: null, project: cwd, pid: null })).toMatch(/s[12]\.jsonl$/);
    expect(transcriptFor({ session: null, project: "/nope", pid: null })).toBeNull();
  });
});

test("stepTitle words", () => {
  expect(stepTitle("Write", { file_path: "/a/b.ts" })).toBe("Writing b.ts");
  expect(stepTitle("mcp__claude-in-chrome__navigate", {})).toBe("Chrome · navigate");
  expect(stepTitle("Bash", { command: "ls", description: "List files" })).toBe("List files");
});
