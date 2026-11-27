import { describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "feed-"));
process.env.AGENTNET_CLAUDE_HOME = home;
const { FeedParser, Sent, stepTitle, toolKind, transcriptFor, projectDir, mcpOf } = await import("./feed");
const fx = join(import.meta.dir, "fixtures", "feed-session.jsonl");
const none = () => null;

describe("parser", () => {
  const p = new FeedParser(fx, "a", none, 0); p.update();
  const by = (id: string) => p.get(id)!;
  test("owner prompt, assistant text (redacted), thinking as its own kind", () => {
    expect(by("u1")).toMatchObject({ kind: "owner", text: "Please run the tests" });
    expect(by("a1:1").text).not.toContain("sk-abcdef");
    expect(by("a1:0")).toMatchObject({ kind: "thinking", text: "secret thoughts" });
    expect(p.items.filter((i) => i.kind !== "thinking").some((i) => i.text?.includes("secret thoughts"))).toBe(false);
  });
  test("thinking text is redacted like the rest; a signature-only block has no text", () => {
    const f = join(home, "th.jsonl"); writeFileSync(f, "");
    const q = new FeedParser(f, "a", none, 0);
    appendFileSync(f, JSON.stringify({ type: "assistant", uuid: "x", timestamp: "2026-11-10T10:00:00Z", message: { content: [{ type: "thinking", thinking: "use API_KEY=sk-abcdef1234567890abcd here" }, { type: "thinking", thinking: "", signature: "zz" }] } }) + "\n"); q.update();
    expect(q.get("x:0")!.text).not.toContain("sk-abcdef"); expect(q.get("x:0")!.text).toContain("use");
    expect(q.get("x:1")).toMatchObject({ kind: "thinking" }); expect(q.get("x:1")!.text).toBeUndefined();
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
  test("a waiting send keeps its lines, so a picture line shows as the picture from the first frame", () => {
    const s = new Sent(); const t0 = Date.parse("2026-11-10T10:00:00Z"), text = "look at this\n[image: /tmp/shots/a.png]";
    s.add("a", text, "n1", t0);
    expect(s.pending("a", t0)[0]!.text).toBe(text);
    expect(s.claim("a", "look at this [image: /tmp/shots/a.png]", t0 + 500)).toEqual({ nonce: "n1" }); // spacing still does not matter to a claim
  });
  test("the owner item carries the nonce of its send", () => {
    const f = join(home, "n.jsonl"); writeFileSync(f, JSON.stringify({ type: "user", uuid: "m1", timestamp: "2026-11-10T10:00:01Z", origin: { kind: "human" }, message: { content: "do it" } }) + "\n");
    const s = new Sent(); s.add("a", "do it", "nx", Date.parse("2026-11-10T10:00:00Z"));
    const p = new FeedParser(f, "a", (a, t, ts) => s.claim(a, t, ts), 0); p.update();
    expect(p.get("m1")).toMatchObject({ kind: "owner", nonce: "nx" });
  });
});

describe("a claimed line keeps its nonce for every reader", () => {
  test("a second parser of the same line (a reconnect, another device) gets the same nonce", () => {
    const f = join(home, "twice.jsonl"); writeFileSync(f, JSON.stringify({ type: "user", uuid: "m9", timestamp: "2026-11-10T10:00:01Z", origin: { kind: "human" }, message: { content: "once" } }) + "\n");
    const s = new Sent(); s.add("a", "once", "nq", Date.parse("2026-11-10T10:00:00Z"));
    const one = new FeedParser(f, "a", (a, t, ts, id) => s.claim(a, t, ts, id), 0); one.update();
    const two = new FeedParser(f, "a", (a, t, ts, id) => s.claim(a, t, ts, id), 0); two.update();
    const hist = new FeedParser(f, "a", (a, _t, _ts, id) => (id ? s.seen(a, id) : null), 0); hist.update();
    expect([one.get("m9")!.nonce, two.get("m9")!.nonce, hist.get("m9")!.nonce]).toEqual(["nq", "nq", "nq"]);
    expect(s.pending("a", Date.parse("2026-11-10T10:00:02Z"))).toHaveLength(0);
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

test("a step through an MCP connector says which one; agentnet's own tools do not", () => {
  expect(mcpOf("mcp__claude_ai_Notion__search")).toEqual({ server: "Notion", tool: "search" });
  expect(mcpOf("Bash")).toBeNull();
  const file = join(home, "mcp.jsonl");
  const use = (id: string, name: string) => ({ type: "tool_use", id, name, input: {} });
  require("node:fs").writeFileSync(file, JSON.stringify({ type: "assistant", uuid: "u1", timestamp: "2026-11-10T10:00:00Z", message: { role: "assistant", content: [use("t1", "mcp__slack__send_message"), use("t2", "mcp__agentnet__send")] } }) + "\n");
  const p = new FeedParser(file, "a", none, 0); p.update();
  const steps = p.items.filter((i) => i.kind === "step");
  expect(steps.map((i) => i.mcp)).toEqual([{ server: "slack", tool: "send_message" }, undefined]);
});

describe("pictures and history", () => {
  const line = (o: object) => JSON.stringify({ timestamp: "2026-11-10T10:00:00Z", ...o }) + "\n";
  test("a long image path or URL survives the secret filter; a secret next to it does not", async () => {
    const { redactText } = await import("./feed");
    const path = "/Users/Someone/Projects/MyApp2026/docs/internal/Shots/After-Change-1920-dark.png";
    expect(redactText(`{"type":"image","src":"${path}"}`)).toContain(path);
    expect(redactText("see https://example.com/Assets/Screens2026/LongFolderNameHere/shot.webp now")).toContain("LongFolderNameHere/shot.webp");
    const out = redactText(`API_KEY=sk-abcdef1234567890abcd ${path} https://user:hunter2@example.com/a.png`);
    expect(out).toContain(path); expect(out).not.toContain("sk-abcdef"); expect(out).not.toContain("hunter2");
  });
  test("a step that reads an image file carries its path; other reads do not", () => {
    const f = join(home, "img.jsonl");
    writeFileSync(f, line({ type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/w/shots/a.PNG" } }, { type: "tool_use", id: "r2", name: "Read", input: { file_path: "/w/a.ts" } }] } })
      + line({ type: "user", uuid: "b", message: { content: [{ type: "tool_result", tool_use_id: "r1", content: "ok" }] } }));
    const q = new FeedParser(f, "a", none, 0); q.update();
    expect(q.get("r1")).toMatchObject({ status: "ok", img: "/w/shots/a.PNG" });
    expect(q.get("r2")!.img).toBeUndefined();
    expect([q.get("r1")!.tool, q.get("r2")!.tool]).toEqual(["image", "read"]);
  });
  test("the stream's parser keeps a window; a history parser keeps everything", () => {
    const f = join(home, "long.jsonl");
    writeFileSync(f, Array.from({ length: 30 }, (_, i) => line({ type: "assistant", uuid: `m${i}`, message: { content: [{ type: "text", text: `reply ${i}` }] } })).join(""));
    const win = new FeedParser(f, "a", none, 0, 10); win.update();
    const all = new FeedParser(f, "a", none, 0, Infinity); all.update();
    expect(win.items.length).toBe(10); expect(all.items.length).toBe(30);
    expect(all.items[0]!.text).toBe("reply 0");
  });
});

describe("the kind of a tool call", () => {
  test("each tool falls in one kind", () => {
    const k = (n: string, i: Record<string, unknown> = {}) => toolKind(n, i);
    expect([k("Read", { file_path: "/a.ts" }), k("Read", { file_path: "/a.webp" }), k("Edit"), k("Write"), k("Grep"), k("Glob"), k("WebFetch"), k("WebSearch"), k("Agent"), k("Bash"), k("mcp__claude-in-chrome__navigate"), k("mcp__playwright__browser_click"), k("mcp__agentnet__send"), k("Skill")])
      .toEqual(["read", "image", "edit", "edit", "search", "search", "web", "web", "agent", "command", "browser", "browser", "other", "other"]);
  });
});

describe("inputText", () => {
  test("the short form of what a call was given", async () => {
    const { inputText } = await import("./feed");
    expect(inputText("Bash", { command: "bun test" })).toBe("bun test");
    expect(inputText("Edit", { old_string: "a", new_string: "b" })).toBe("old a\nnew b");
    expect(inputText("Grep", { pattern: "wk-tile", path: "web/src" })).toBe("wk-tile in web/src");
    expect(inputText("Read", { file_path: "/x/y.ts" })).toBe("/x/y.ts");
    expect(inputText("Bash", {})).toBe("");
    expect(inputText("Bash", { command: "x".repeat(5000) }).length).toBeLessThanOrEqual(1501);
  });
});

describe("stepFile", () => {
  test("a Write keeps its path and content, an Edit and a MultiEdit their old and new text", async () => {
    const { stepFile, WRITE_MAX, EDIT_MAX } = await import("./feed");
    expect(stepFile("Write", { file_path: "/r/a.ts", content: "const a = 1;\n" })).toEqual({ path: "/r/a.ts", content: "const a = 1;\n" });
    expect(stepFile("Edit", { file_path: "/r/a.ts", old_string: "a", new_string: "b" })).toEqual({ path: "/r/a.ts", edits: [{ old: "a", new: "b" }] });
    expect(stepFile("MultiEdit", { file_path: "/r/a.ts", edits: [{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "q" }] })!.edits).toEqual([{ old: "x", new: "y" }, { old: "p", new: "q" }]);
    expect(stepFile("Read", { file_path: "/r/a.ts" })).toBeNull();
    expect(stepFile("Write", { content: "no path" })).toBeNull();
    expect(stepFile("Write", { file_path: "/r/b.md", content: "x".repeat(20_000) })!.content!.length).toBeLessThanOrEqual(WRITE_MAX + 1);
    const big = stepFile("MultiEdit", { file_path: "/r/a.ts", edits: Array.from({ length: 10 }, () => ({ old_string: "o".repeat(1000), new_string: "n".repeat(1000) })) })!;
    expect(big.edits!.reduce((n, e) => n + e.old.length + e.new.length, 0)).toBeLessThanOrEqual(EDIT_MAX + 4);
  });
});

describe("owner chat handed over by the plugin", () => {
  test("an asUser agentnet prompt is the owner and claims its nonce; a framed one stays a delivery", () => {
    const f = join(home, "ov.jsonl");
    writeFileSync(f, [
      JSON.stringify({ type: "user", uuid: "o1", timestamp: "2026-11-24T10:00:00Z", origin: { kind: "plugin", name: "agentnet", asUser: true }, message: { content: "hello from the page" } }),
      JSON.stringify({ type: "user", uuid: "o2", timestamp: "2026-11-24T10:00:01Z", origin: { kind: "plugin", name: "agentnet" }, message: { content: "boot text" } }),
      JSON.stringify({ type: "user", uuid: "o3", timestamp: "2026-11-24T10:00:02Z", origin: { kind: "plugin", name: "other", asUser: true }, message: { content: "not ours" } }),
    ].join("\n") + "\n");
    const p = new FeedParser(f, "a", (_a: string, t: string) => (t === "hello from the page" ? { nonce: "n-9" } : null), 0); p.update();
    expect(p.items.map((i) => [i.id, i.kind])).toEqual([["o1", "owner"]]);
    expect(p.items[0]).toMatchObject({ text: "hello from the page", nonce: "n-9" });
  });
});

describe("a long tmux paste wrapped in <pasted_content>", () => {
  test("claims its nonce and shows the owner's text without the wrapper, typed or queued mid-turn", () => {
    const f = join(home, "paste.jsonl"), body = "[T1] ignore the filler\n" + "filler line 0123456789.\n".repeat(200) + "END T1";
    const wrapped = `\n\n<pasted_content id="49b9">\n${body}\n</pasted_content id="49b9">\n`;
    writeFileSync(f, [
      JSON.stringify({ type: "user", uuid: "p1", timestamp: "2026-11-24T10:00:00Z", origin: { kind: "human" }, message: { content: wrapped } }),
      JSON.stringify({ type: "attachment", uuid: "p2", timestamp: "2026-11-24T10:00:01Z", attachment: { type: "queued_command", prompt: `look: ${wrapped}` } }),
    ].join("\n") + "\n");
    const s = new Sent(); s.add("a", body, "n-1", Date.parse("2026-11-24T09:59:59Z")); s.add("a", `look: ${body}`, "n-2", Date.parse("2026-11-24T09:59:59Z"));
    const p = new FeedParser(f, "a", (a, t, ts) => s.claim(a, t, ts), 0); p.update();
    expect(p.items.map((i) => [i.id, i.kind, (i as { nonce?: string }).nonce])).toEqual([["p1", "owner", "n-1"], ["p2", "owner", "n-2"]]);
    expect((p.items[0] as { text: string }).text.startsWith("[T1] ignore the filler")).toBe(true);
    expect((p.items[0] as { text: string }).text).not.toContain("pasted_content");
    expect(s.pending("a", Date.parse("2026-11-24T10:00:02Z"))).toEqual([]);
  });
});
