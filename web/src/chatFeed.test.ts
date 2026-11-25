import { describe, expect, it, test } from "bun:test";
import { RUN_MS, buildRows, doneWord, groupCalls, railSteps, squares, feedItems, harnessNote, lastStep, monogram, ownerKey, picProblem, promptHistory, rail, runs, splitImages, ticks, turns, withImages, workLine, workSum, type FeedItem, type PlanBit, type Row } from "./chatFeed";
import type { Msg } from "./net";

const step = (n: number, status: FeedItem["status"] = "ok"): FeedItem => ({ id: `t${n}`, ts: 1000 + n, kind: "step", title: `Step ${n}`, status });
const msg = (at: number): Msg => ({ id: at, from: "root", to: "a", kind: "info", body: "hi", at });

describe("buildRows", () => {
  test("merges messages and feed by time; thinking and steps between bubbles fold into one work row", () => {
    const items: FeedItem[] = [{ id: "th", ts: 1000, kind: "thinking", text: "hm" }, step(1), step(2), step(3, "error"), { id: "a1", ts: 1010, kind: "assistant", text: "done" }, step(11)];
    const rows = buildRows([msg(1005)], items, "all");
    expect(rows.map((r) => r.type)).toEqual(["work", "msg", "assistant", "work"]);
    const g = rows[0]!; if (g.type !== "work") throw 0;
    expect(g).toMatchObject({ steps: 3, thoughts: 1, failed: 1, running: false });
    expect(workLine(g)).toBe("Thought, ran 3 steps");
  });
  test("a message between steps splits the run", () => {
    const rows = buildRows([msg(1002)], [step(1), step(2), step(3)], "all");
    expect(rows.map((r) => r.type)).toEqual(["work", "msg", "work"]);
  });
  test("the folded line: the running step while it runs, then the count and the time", () => {
    const run = buildRows([], [step(1), { ...step(2, "running"), title: "Editing x.ts" }], "all")[0]!; if (run.type !== "work") throw 0;
    expect(workLine(run)).toBe("Editing x.ts");
    const done = buildRows([], [{ id: "a", ts: 0, kind: "step", title: "A", status: "ok" }, { id: "b", ts: 60_000, kind: "step", title: "B", status: "ok", ms: 12_000 }], "all")[0]!; if (done.type !== "work") throw 0;
    expect(workLine(done)).toBe("Ran 2 steps in 1 min 12 s");
    const th = buildRows([], [{ id: "t", ts: 0, kind: "thinking" }], "all")[0]!; if (th.type !== "work") throw 0;
    expect(workLine(th)).toBe("Thought");
  });
  test("filters: messages = agentnet only, terminal = feed only", () => {
    const items: FeedItem[] = [step(1), { id: "o", ts: 1500, kind: "owner", text: "yo" }];
    expect(buildRows([msg(1)], items, "messages").map((r) => r.type)).toEqual(["msg"]);
    expect(buildRows([msg(1)], items, "terminal").map((r) => r.type)).toEqual(["work", "owner"]);
  });
  test("delivery and event become small notes", () => {
    const rows = buildRows([], [{ id: "d", ts: 1, kind: "delivery", msg: 7 }, { id: "e", ts: 2, kind: "event", text: "Compacted" }], "all");
    expect(rows.map((r) => r.type === "note" && r.text)).toEqual(["message #7 delivered", "Compacted"]);
  });
  test("an owner prompt keeps one key and moves sending, sent, shown; failed carries the reason", () => {
    const row = (i: FeedItem) => { const r = buildRows([], [i], "all")[0]!; if (r.type !== "owner") throw 0; return r; };
    const a = row({ id: "sending:n1", ts: 1, kind: "owner", text: "go", nonce: "n1", sending: true });
    const b = row({ id: "sending:n1", ts: 1, kind: "owner", text: "go", nonce: "n1", sending: false });
    const c = row({ id: "u1", ts: 2, kind: "owner", text: "go", nonce: "n1" });
    const f = row({ id: "sending:n1", ts: 1, kind: "owner", text: "go", nonce: "n1", failed: true, error: "no terminal" });
    expect([a.state, b.state, c.state, f.state]).toEqual(["sending", "sent", "shown", "failed"]);
    expect(new Set([a.key, b.key, c.key, f.key]).size).toBe(1); expect(f.error).toBe("no terminal");
    expect(ownerKey({ id: "u9", ts: 1, kind: "owner" })).toBe("o:u9");
  });
  test("prompt history: newest first, no repeats", () => {
    const o = (id: string, ts: number, text: string): FeedItem => ({ id, ts, kind: "owner", text });
    expect(promptHistory(buildRows([], [o("1", 1, "a"), o("2", 2, "b"), o("3", 3, "a")], "all"))).toEqual(["a", "b"]);
  });
});

describe("feedItems", () => {
  test("a sending bubble is replaced by the transcript line with the same nonce", () => {
    const items = new Map<string, FeedItem>([["u1", { id: "u1", ts: 5, kind: "owner", text: "go", nonce: "n1" }]]);
    const pending: FeedItem[] = [{ id: "sending:n1", ts: 4, kind: "owner", text: "go", nonce: "n1", sending: true }, { id: "sending:n2", ts: 6, kind: "owner", text: "next", nonce: "n2", sending: true }];
    expect(feedItems(items, pending).map((i) => i.id)).toEqual(["u1", "sending:n2"]);
  });
  test("a transcript line without its nonce still replaces its bubble: the owner's message shows once", () => {
    // the line was claimed by another reader (a reconnected stream, a second device), so it came without the nonce
    const items = new Map<string, FeedItem>([["u1", { id: "u1", ts: 10_000, kind: "owner", text: "load  previous\nmessages" }]]);
    const pending: FeedItem[] = [{ id: "sending:n1", ts: 9_000, kind: "owner", text: "load previous messages", nonce: "n1", sending: false }];
    const out = feedItems(items, pending);
    expect(out.map((i) => i.id)).toEqual(["u1"]);
    expect(buildRows([], out, "all").filter((r) => r.type === "owner")).toHaveLength(1);
  });
  test("the same text sent twice: one line takes one bubble, the second waits for its own line", () => {
    const items = new Map<string, FeedItem>([["u1", { id: "u1", ts: 10_000, kind: "owner", text: "again" }]]);
    const pending: FeedItem[] = [{ id: "sending:n1", ts: 9_000, kind: "owner", text: "again", nonce: "n1" }, { id: "sending:n2", ts: 9_500, kind: "owner", text: "again", nonce: "n2" }];
    expect(feedItems(items, pending).map((i) => i.id)).toEqual(["u1", "sending:n2"]);
  });
  test("an older line with the same text does not swallow a new send", () => {
    const items = new Map<string, FeedItem>([["u0", { id: "u0", ts: 1_000, kind: "owner", text: "yes" }]]);
    const pending: FeedItem[] = [{ id: "sending:n1", ts: 60_000, kind: "owner", text: "yes", nonce: "n1", sending: true }];
    expect(feedItems(items, pending).map((i) => i.id)).toEqual(["u0", "sending:n1"]);
  });
});

describe("runs", () => {
  const day = (t: number) => String(Math.floor(t / 86_400_000));
  const a = (id: string, ts: number): FeedItem => ({ id, ts, kind: "assistant", text: "x" });
  test("one header per run of the same speaker; a step, another speaker or a 5 minute gap starts a new run", () => {
    const rows = buildRows([], [a("a1", 1000), a("a2", 2000), step(3000), a("a3", 5000), { id: "o1", ts: 6000, kind: "owner", text: "hi" }, a("a4", 7000), a("a5", 7000 + RUN_MS + 1)], "all");
    expect(rows.map((r) => r.type)).toEqual(["assistant", "assistant", "work", "assistant", "owner", "assistant", "assistant"]);
    expect(runs(rows, day).map((r) => `${+r.first}${+r.last}`)).toEqual(["10", "01", "00", "11", "11", "11", "11"]);
  });
  test("messages group by sender and receiver; a new day breaks the run", () => {
    const m = (at: number, to: string): Msg => ({ id: at, from: "root", to, kind: "info", body: "hi", at });
    const rows = buildRows([m(1000, "a"), m(2000, "a"), m(3000, "b"), m(86_400_000 + 10, "b")], [], "messages");
    expect(runs(rows, day).map((r) => `${+r.first}${+r.last}`)).toEqual(["10", "01", "11", "11"]);
  });
});

describe("round 2 helpers", () => {
  const it0 = (id: string, kind: "thinking" | "tool", status: FeedItem["status"] = "ok"): FeedItem => (kind === "thinking" ? { id, ts: 1, kind, text: "t" } : { id, ts: 1, kind: "step", title: "Run", status });
  test("ticks: one mark per thought and step, in its state, newest kept", () => {
    expect(ticks([it0("a", "thinking"), it0("b", "tool"), it0("c", "tool", "error"), it0("d", "tool", "running")])).toEqual(["think", "ok", "bad", "run"]);
    expect(ticks(Array.from({ length: 40 }, (_, i) => it0("x" + i, "tool", i === 39 ? "error" : "ok")), 5)).toEqual(["ok", "ok", "ok", "ok", "bad"]);
  });
  test("monogram: initials and number, as on the map", () => {
    expect(monogram("designer-4")).toBe("D4");
    expect(monogram("web-dev-1")).toBe("WD1");
    expect(monogram("root")).toBe("R");
    expect(monogram("7")).toBe("77");
    expect(monogram("")).toBe("?");
  });
  test("turns: each prompt with the first line of the reply, its blocks and its run", () => {
    const rows: Row[] = [
      { type: "assistant", key: "a:0", at: 1, text: "before any prompt" },
      { type: "owner", key: "o:1", at: 2, text: "Do it", state: "shown" },
      { type: "work", key: "w:1", at: 3, items: [it0("a", "thinking"), it0("b", "tool", "error")], steps: 1, failed: 1, running: false, ms: 5 },
      { type: "assistant", key: "a:1", at: 4, text: "## Done\n\nAll good.\n\n```ui\n{\"type\":\"card\"}\n```\n\n```ui-html\n<b>x</b>\n```" },
      { type: "owner", key: "o:2", at: 5, text: "More", state: "shown" },
      { type: "work", key: "w:2", at: 6, items: [it0("c", "tool", "running")], steps: 1, failed: 0, running: true, ms: 0 },
    ] as Row[];
    const t = turns(rows);
    expect(t.map((x) => x.k)).toEqual(["o:1", "o:2"]);
    expect(t[0]).toMatchObject({ text: "Do it", reply: "Done", blocks: 2, ticks: ["think", "bad"], running: false, failed: 1 });
    expect(t[1]).toMatchObject({ reply: "", running: true, ticks: ["run"] });
  });
});

describe("the agent's rail", () => {
  const it = (id: string, kind: string, ts: number, x: Partial<FeedItem> = {}): FeedItem => ({ id, kind, ts, ...x }) as FeedItem;
  const rows = buildRows([], [
    it("o1", "owner", 1, { text: "go" }),
    it("a1", "assistant", 2, { text: "On it." }),
    it("t1", "thinking", 3), it("s1", "step", 4, { title: "Reading a.ts", status: "ok", ms: 20 }), it("s2", "step", 90_000, { title: "Running tests", status: "ok", ms: 500 }),
    it("e1", "event", 91_000, { text: "Compacted" }),
    it("a2", "assistant", 92_000, { text: "Done." }),
    it("o2", "owner", 93_000, { text: "thanks" }),
    it("s3", "step", 94_000, { title: "Using git", status: "ok", ms: 10 }),
  ], "terminal");
  test("the agent's words, work and notes are on the rail; the owner breaks it", () => {
    expect(rows.map((r) => r.type)).toEqual(["owner", "assistant", "work", "note", "assistant", "owner", "work"]);
    const r = rail(rows);
    expect(r.map((p) => p.on)).toEqual([false, true, true, true, true, false, true]);
    expect(r.map((p) => p.head)).toEqual([false, true, false, false, false, false, true]);
    expect(r.map((p) => p.end)).toEqual([false, false, false, false, true, false, true]);
  });
  test("a run says what it did and where it ended", () => {
    const w = rows[2] as Extract<Row, { type: "work" }>;
    expect(workSum(w)).toBe("2 steps, 1 thought in 1 min 30 s");
    expect(lastStep(w)).toBe("Running tests");
    expect(workSum(rows[6] as Extract<Row, { type: "work" }>)).toBe("1 step");
  });
});

describe("text the harness typed is not the owner", () => {
  test("a subagent hand-back and a compaction summary become notes that keep their text", () => {
    const hand = "<agent-message from=\"a1\">\n[Subagent hand-back] The text below is the final report";
    const rows = buildRows([], [{ id: "h", ts: 1, kind: "owner", text: hand }, { id: "c", ts: 2, kind: "owner", text: "This session is being continued from a previous conversation that ran out of context." }, { id: "o", ts: 3, kind: "owner", text: "Ship it" }], "terminal");
    expect(rows.map((r) => r.type)).toEqual(["note", "note", "owner"]);
    expect(rows[0]).toMatchObject({ text: "A subagent reported back", body: hand });
    expect(rows[1]).toMatchObject({ text: "Summary of the earlier conversation" });
    expect(promptHistory(rows)).toEqual(["Ship it"]);
  });
  test("the owner quoting those words is still the owner", () => {
    expect(harnessNote("Why does <agent-message show as me?")).toBeNull();
    expect(harnessNote("ok")).toBeNull();
  });
});

describe("pictures in a prompt", () => {
  test("picture lines come out of the text and back in", () => {
    const t = withImages("Look at this", ["/home/u/data/chat-images/a/1.png", "/tmp/b c.jpeg"]);
    expect(t).toBe("Look at this\n[image: /home/u/data/chat-images/a/1.png]\n[image: /tmp/b c.jpeg]");
    expect(splitImages(t)).toEqual({ text: "Look at this", images: ["/home/u/data/chat-images/a/1.png", "/tmp/b c.jpeg"] });
    expect(withImages("", ["/a.png"])).toBe("[image: /a.png]");
  });
  test("a picture that cannot be sent says why, never vanishes", () => {
    expect(picProblem("image/png", 1000, 0)).toBe("");
    expect(picProblem("image/heic", 1000, 0)).toBe("Only PNG, JPEG, GIF or WebP");
    expect(picProblem("image/png", 11 * 1024 * 1024, 0)).toBe("Over 10 MB");
    expect(picProblem("image/png", 1000, 6)).toBe("Only 6 pictures per message");
  });
  test("text that only looks similar stays text", () => {
    for (const t of ["[image: relative.png]", "see [image: /a.png] inline", "[image: /a.txt]", "plain"]) expect(splitImages(t)).toEqual({ text: t, images: [] });
  });
});

describe("trail grouping", () => {
  const mk = (n: number, ts: number, status: FeedItem["status"] = "ok"): FeedItem => ({ id: `g${n}`, ts, kind: "step", title: `S${n}`, status });
  it("puts each call under the plan step open when it ran", () => {
    const plan = [{ n: 1, text: "a", status: "done" as const, at: 100, end: 200, proofs: [] }, { n: 2, text: "b", status: "active" as const, at: 200, proofs: [] }];
    const g = groupCalls([mk(1, 50), mk(2, 120), mk(3, 150), mk(4, 300)], plan);
    expect(g.map((x) => [x.step?.n ?? 0, x.items.length])).toEqual([[0, 1], [1, 2], [2, 1]]);
  });
  it("one group with no step when there is no plan", () => {
    expect(groupCalls([mk(1, 1), mk(2, 2)], [])).toHaveLength(1);
  });
  it("squares: one per call, thoughts skipped", () => {
    expect(squares([mk(1, 1), { id: "t", ts: 2, kind: "thinking", text: "x" }, mk(2, 3, "error"), mk(3, 4, "running")])).toEqual(["ok", "bad", "run"]);
  });
});

describe("railSteps", () => {
  const mk = (n: number, ts: number, status: FeedItem["status"] = "ok"): FeedItem => ({ id: `c${n}`, ts, kind: "step", title: `c${n}`, status });
  const bit = (n: number, status: PlanBit["status"], at?: number, end?: number): PlanBit => ({ n, text: `s${n}`, status, ...(at != null ? { at } : {}), ...(end != null ? { end } : {}), proofs: [] });
  it("calls before the plan first, then the steps with calls, then the pending steps after the open one", () => {
    const g = railSteps([mk(1, 5), mk(2, 50), mk(3, 150)], [bit(1, "done", 10, 99), bit(2, "active", 100), bit(3, "pending"), bit(4, "pending")]);
    expect(g?.map((x) => [x.step?.n ?? 0, x.items.length])).toEqual([[0, 1], [1, 1], [2, 1], [3, 0], [4, 0]]);
  });
  it("no pending tail when the run ends on a done step", () => {
    const g = railSteps([mk(1, 50)], [bit(1, "done", 10, 99), bit(2, "pending")]);
    expect(g?.map((x) => x.step?.n)).toEqual([1]);
  });
  it("null when no call falls in a step", () => {
    expect(railSteps([mk(1, 5)], [bit(1, "active", 100)])).toBeNull();
    expect(railSteps([mk(1, 5)], [])).toBeNull();
  });
  it("doneWord says the failures after Done", () => {
    expect(doneWord(0)).toBe("Done");
    expect(doneWord(1)).toBe("Done, 1 failed");
  });
});
