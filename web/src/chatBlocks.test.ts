import { describe, expect, test } from "bun:test";
import { BLOCK_TYPES, liveTaskState, parseBlock, parseFence, splitBlocks, HTML_MAX } from "./chatBlocks";

const fence = (o: unknown) => "```ui\n" + JSON.stringify(o) + "\n```";

describe("splitBlocks", () => {
  test("plain markdown is one part", () => expect(splitBlocks("hello **there**")).toEqual([{ kind: "md", text: "hello **there**" }]));
  test("markdown, a block, markdown: in order", () => {
    const s = splitBlocks(`Before\n\n${fence({ type: "card", title: "Done" })}\n\nAfter`);
    expect(s.map((x) => x.kind)).toEqual(["md", "ui", "md"]);
    expect(s[1]).toMatchObject({ blocks: [{ type: "card", title: "Done", tone: "info" }] });
  });
  test("a list of blocks in one fence", () => {
    const s = splitBlocks(fence([{ type: "card", body: "a" }, { type: "stats", items: [{ label: "Tests", value: 12 }] }]));
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: "ui", blocks: [{ type: "card" }, { type: "stats", items: [{ label: "Tests", value: "12" }] }] });
  });
  test("bad JSON, an unknown type or a missing field stays in the markdown as code", () => {
    for (const bad of ["```ui\n{not json\n```", fence({ type: "rocket" }), fence({ type: "table", columns: [] }), fence([{ type: "card", title: "ok" }, { type: "nope" }])]) {
      expect(splitBlocks(`x\n\n${bad}`)).toEqual([{ kind: "md", text: `x\n\n${bad}` }]);
    }
  });
  test("another language fence is never a block", () => expect(splitBlocks('```json\n{"type":"card","title":"x"}\n```')[0]!.kind).toBe("md"));
});

describe("parseBlock", () => {
  test("every starter type parses from its smallest form", () => {
    const min: Record<(typeof BLOCK_TYPES)[number], unknown> = {
      card: { type: "card", body: "text" },
      stats: { type: "stats", items: [{ label: "a", value: "1" }] },
      table: { type: "table", columns: ["a"], rows: [["1"]] },
      checklist: { type: "checklist", items: ["one"] },
      choices: { type: "choices", options: ["Yes", "No"] },
      section: { type: "section", title: "More", body: "text" },
      steps: { type: "steps", items: ["one"] },
      image: { type: "image", src: "https://example.com/a.png" },
      file: { type: "file", path: "web/src/a.ts" },
      task: { type: "task", id: "1.2", title: "Build it" },
      draft: { type: "draft", title: "Status", body: "Done." },
      result: { type: "result", title: "Shipped" },
      jira: { type: "jira", project: "AGN", tickets: [{ title: "Fix it" }] },
    };
    for (const t of BLOCK_TYPES) expect(parseBlock(min[t])).toMatchObject({ type: t });
  });
  test("choices: a plain label sends itself; send overrides", () => {
    expect(parseBlock({ type: "choices", options: ["Yes", { label: "No", send: "No, stop here" }] })).toMatchObject({ options: [{ label: "Yes", send: "Yes" }, { label: "No", send: "No, stop here" }] });
  });
  test("table rows are padded and cut to the columns; align defaults to left", () => {
    expect(parseBlock({ type: "table", columns: ["a", "b"], rows: [["1"], ["1", "2", "3"]], align: ["left", "right"] })).toMatchObject({ rows: [["1", ""], ["1", "2"]], align: ["left", "right"] });
  });
  test("image takes a web address or an absolute path to an image file, nothing else", () => {
    for (const src of ["javascript:alert(1)", "data:image/png;base64,AA", "/etc/passwd", "file:///x.png", "//evil.example/a.png", "shots/a.png", "/a.png\n/etc/passwd"]) expect(parseBlock({ type: "image", src })).toBeNull();
    for (const src of ["/home/u/project/shots/a b.png", "/tmp/x.JPEG", "https://example.com/a.png"]) expect(parseBlock({ type: "image", src })).toMatchObject({ type: "image", src });
  });
  test("long text is cut, long lists are capped, unknown tone and state fall back", () => {
    const c = parseBlock({ type: "card", title: "t".repeat(500), tone: "pink" });
    expect(c).toMatchObject({ tone: "info" }); if (c?.type !== "card") throw 0; expect(c.title!.length).toBeLessThanOrEqual(201);
    const s = parseBlock({ type: "steps", items: Array.from({ length: 90 }, (_, i) => ({ text: `s${i}`, state: "weird" })) });
    if (s?.type !== "steps") throw 0; expect(s.items).toHaveLength(40); expect(s.items[0]!.state).toBe("todo");
  });
  test("not an object, or no type: null", () => { for (const v of [null, 3, "card", [], {}]) expect(parseBlock(v)).toBeNull(); });
});

describe("parseFence", () => {
  test("one object or a list", () => { expect(parseFence('{"type":"card","title":"a"}')).toHaveLength(1); expect(parseFence('[{"type":"card","title":"a"},{"type":"card","title":"b"}]')).toHaveLength(2); });
  test("empty list is not a block", () => expect(parseFence("[]")).toBeNull());
});

describe("live UI fences (ui-html)", () => {
  const fence = (body: string, lang = "ui-html") => "```" + lang + "\n" + body + "\n```";
  test("a ui-html fence becomes an html part, as written, in order with text and blocks", () => {
    const html = "<button data-send=\"Yes\">Yes</button>\n<script>let a = 1 < 2;</script>";
    const parts = splitBlocks("Before\n\n" + fence(html) + "\n\nBetween\n\n" + fence("{\"type\":\"card\",\"title\":\"t\"}", "ui") + "\n\nAfter");
    expect(parts.map((p) => p.kind)).toEqual(["md", "html", "md", "ui", "md"]);
    expect(parts[1]).toEqual({ kind: "html", html });
  });
  test("an empty fence stays as code", () => {
    const text = fence("   ");
    expect(splitBlocks(text)).toEqual([{ kind: "md", text }]);
  });
  test("a fence over the size limit stays as code; one at the limit runs", () => {
    const big = fence("x".repeat(HTML_MAX + 1));
    expect(splitBlocks(big)).toEqual([{ kind: "md", text: big }]);
    expect(splitBlocks(fence("x".repeat(HTML_MAX)))[0]!.kind).toBe("html");
  });
  test("only the exact language runs: html, ui-htmlx and an unclosed fence stay text", () => {
    for (const text of [fence("<b>x</b>", "html"), fence("<b>x</b>", "ui-htmlx"), "```ui-html\n<b>x</b>"]) expect(splitBlocks(text)).toEqual([{ kind: "md", text }]);
  });
});

describe("file, task and draft blocks", () => {
  test("file: a path with a known extension, lines from the field or the :N-M tail", () => {
    expect(parseBlock({ type: "file", path: "web/src/a.ts:40-58" })).toMatchObject({ path: "web/src/a.ts", lines: "40-58" });
    expect(parseBlock({ type: "file", path: "/Users/x/a b.ts" })).toBeNull();
    expect(parseBlock({ type: "file", path: "web/src/a.ts", lines: "3", note: "n" })).toMatchObject({ lines: "3", note: "n" });
    for (const path of ["https://x.com/a.ts", "a.exe", "src/", "", "a.ts\nb.ts"]) expect(parseBlock({ type: "file", path })).toBeNull();
  });
  test("task: kind and state fall back; progress must be n/m", () => {
    expect(parseBlock({ type: "task", id: 8931, title: "T", kind: "ticket", state: "blocked", progress: "2/4", owner: "root" })).toMatchObject({ id: "8931", kind: "ticket", state: "blocked", progress: "2/4", owner: "root" });
    expect(parseBlock({ type: "task", id: "1", title: "T", kind: "x", state: "y", progress: "half" })).toMatchObject({ kind: "step", state: "todo", progress: undefined });
    expect(parseBlock({ type: "task", id: "1" })).toBeNull();
  });
  test("draft: needs title and body; at most two actions", () => {
    expect(parseBlock({ type: "draft", title: "T", body: "B", actions: ["Send", "Edit", "Third", ""] })).toMatchObject({ kind: "message", actions: ["Send", "Edit"] });
    expect(parseBlock({ type: "draft", title: "T" })).toBeNull();
  });
  test("task: wait is a state, sub and note are kept", () => {
    expect(parseBlock({ type: "task", id: "8933", title: "T", state: "wait", sub: "Message, kind task", note: "Needs an answer" })).toMatchObject({ state: "wait", sub: "Message, kind task", note: "Needs an answer" });
  });
  test("result: kind falls back to done; figures, checks and tags are cut and cleaned", () => {
    const r = parseBlock({ type: "result", kind: "commit", title: "feat", ref: "839475a", figures: [{ value: "9", label: "files" }, { value: "", label: "x" }, "bad"], checks: ["typecheck", { text: "build", state: "wait" }, { text: "q", state: "zzz" }], tags: ["dark", "", "1 of 18"] });
    expect(r).toMatchObject({ kind: "commit", figures: [{ value: "9", label: "files" }], checks: [{ text: "typecheck", state: "done" }, { text: "build", state: "wait" }, { text: "q", state: "done" }], tags: ["dark", "1 of 18"] });
    expect(parseBlock({ type: "result", kind: "zzz", title: "T" })).toMatchObject({ kind: "done", figures: [], checks: [] });
    expect(parseBlock({ type: "result", title: "T", image: "https://x.test/a.png" })).toMatchObject({ image: "https://x.test/a.png" });
    expect(parseBlock({ type: "result" })).toBeNull();
  });
});

describe("markers in plain markdown", () => {
  test("text with no marker comes back untouched", () => {
    const t = "A line.\n\n> a quote\n\nSee `web/src/a.ts` for it, and a.b";
    expect(splitBlocks(t)).toEqual([{ kind: "md", text: t }]);
  });
  test("an alert becomes a card, the tone from the word", () => {
    const s = splitBlocks("Before\n\n> [!WARN]\n> Two tests skipped.\n> Check them.\n\nAfter");
    expect(s.map((x) => x.kind)).toEqual(["md", "ui", "md"]);
    expect(s[1]).toMatchObject({ blocks: [{ type: "card", tone: "warn", body: "Two tests skipped.\nCheck them." }] });
    expect(splitBlocks("> [!NOTE]\n> hi")[0]).toMatchObject({ blocks: [{ tone: "info" }] });
  });
  test("an alert with no body stays text; so does one inside a code fence", () => {
    expect(splitBlocks("> [!OK]")).toEqual([{ kind: "md", text: "> [!OK]" }]);
    const t = "```md\n> [!OK]\n> x\n```";
    expect(splitBlocks(t)).toEqual([{ kind: "md", text: t }]);
  });
  test("a path alone on a line becomes a file card, with or without backticks", () => {
    for (const l of ["web/src/chatBlocks.ts:42", "`web/src/chatBlocks.ts:42`"]) {
      const s = splitBlocks(`Look:\n\n${l}\n\nDone`);
      expect(s.map((x) => x.kind)).toEqual(["md", "ui", "md"]);
      expect(s[1]).toMatchObject({ blocks: [{ type: "file", path: "web/src/chatBlocks.ts", lines: "42" }] });
    }
  });
  test("a markdown picture alone on a line becomes a picture file card; a web picture stays text", () => {
    for (const l of ["![The chat](docs/shots/chat.png)", '![x](<docs/shots/chat.png> "title")']) {
      const s = splitBlocks(`Look:\n\n${l}\n\nDone`);
      expect(s.map((x) => x.kind)).toEqual(["md", "ui", "md"]);
      expect(s[1]).toMatchObject({ blocks: [{ type: "file", path: "docs/shots/chat.png" }] });
    }
    const w = "![x](https://example.com/a.png)";
    expect(splitBlocks(w)).toEqual([{ kind: "md", text: w }]);
  });
  test("a path inside a sentence, or a code fence, stays text", () => {
    const t = "Edit web/src/a.ts now\n\n```\nweb/src/a.ts\n```";
    expect(splitBlocks(t)).toEqual([{ kind: "md", text: t }]);
  });
  test("markers work around a ui fence too", () => {
    const s = splitBlocks(`web/src/a.ts\n\n${fence({ type: "card", title: "x" })}`);
    expect(s.map((x) => x.kind)).toEqual(["ui", "ui"]);
  });
});

describe("a task card's live state", () => {
  const agents = [{ id: "a1", name: "designer-4", jobs: [{ id: 1, closedAt: null, outcome: null, steps: [{ n: 1, status: "done" }, { n: 2, status: "active" }] }, { id: 2, closedAt: 5, outcome: "done", steps: [] }] }];
  const task = (o: Record<string, unknown>) => parseBlock({ type: "task", kind: "step", id: "1.2", title: "Board", state: "active", owner: "designer-4", ...o }) as Extract<ReturnType<typeof parseBlock>, { type: "task" }>;
  test("a step and a job read from the owner's plan", () => {
    expect(liveTaskState(task({}), agents)).toBe("active");
    expect(liveTaskState(task({ id: "1.1" }), agents)).toBe("done");
    expect(liveTaskState(task({ kind: "job", id: "2" }), agents)).toBe("done");
    expect(liveTaskState(task({ kind: "job", id: "1" }), agents)).toBe("active");
  });
  test("unknown when the page cannot know", () => {
    expect(liveTaskState(task({ owner: "nobody" }), agents)).toBeNull();
    expect(liveTaskState(task({ id: "9.1" }), agents)).toBeNull();
    expect(liveTaskState(task({ kind: "ticket", id: "AGN-1" }), agents)).toBeNull();
    expect(liveTaskState(task({ owner: undefined }), agents)).toBeNull();
  });
});
