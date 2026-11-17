import { describe, expect, test } from "bun:test";
import { RUN_MS, buildRows, feedItems, runs, type FeedItem } from "./chatFeed";
import type { Msg } from "./net";

const step = (n: number, status: FeedItem["status"] = "ok"): FeedItem => ({ id: `t${n}`, ts: 1000 + n, kind: "step", title: `Step ${n}`, status });
const msg = (at: number): Msg => ({ id: at, from: "root", to: "a", kind: "info", body: "hi", at });

describe("buildRows", () => {
  test("merges messages and feed by time; 3+ steps in a row collapse into one group, 2 stay single", () => {
    const items: FeedItem[] = [step(1), step(2), step(3, "error"), { id: "a1", ts: 1010, kind: "assistant", text: "done" }, step(11), step(12)];
    const rows = buildRows([msg(1005)], items, "all");
    expect(rows.map((r) => r.type)).toEqual(["steps", "msg", "assistant", "step", "step"]);
    const g = rows[0]!; if (g.type !== "steps") throw 0;
    expect(g.steps).toHaveLength(3); expect(g.failed).toBe(1);
  });
  test("a message between steps splits the run", () => {
    const rows = buildRows([msg(1002)], [step(1), step(2), step(3)], "all");
    expect(rows.map((r) => r.type)).toEqual(["step", "msg", "step", "step"]);
  });
  test("filters: messages = agentnet only, terminal = feed only", () => {
    const items: FeedItem[] = [step(1), { id: "o", ts: 1500, kind: "owner", text: "yo" }];
    expect(buildRows([msg(1)], items, "messages").map((r) => r.type)).toEqual(["msg"]);
    expect(buildRows([msg(1)], items, "terminal").map((r) => r.type)).toEqual(["step", "owner"]);
  });
  test("delivery and event become small notes", () => {
    const rows = buildRows([], [{ id: "d", ts: 1, kind: "delivery", msg: 7 }, { id: "e", ts: 2, kind: "event", text: "Compacted" }], "all");
    expect(rows.map((r) => r.type === "note" && r.text)).toEqual(["message #7 delivered", "Compacted"]);
  });
});

describe("feedItems", () => {
  test("a sending bubble is replaced by the transcript line with the same nonce", () => {
    const items = new Map<string, FeedItem>([["u1", { id: "u1", ts: 5, kind: "owner", text: "go", nonce: "n1" }]]);
    const pending: FeedItem[] = [{ id: "sending:n1", ts: 4, kind: "owner", text: "go", nonce: "n1", sending: true }, { id: "sending:n2", ts: 6, kind: "owner", text: "next", nonce: "n2", sending: true }];
    expect(feedItems(items, pending).map((i) => i.id)).toEqual(["u1", "sending:n2"]);
  });
});

describe("runs", () => {
  const day = (t: number) => String(Math.floor(t / 86_400_000));
  const a = (id: string, ts: number): FeedItem => ({ id, ts, kind: "assistant", text: "x" });
  test("one header per run of the same speaker; a step, another speaker or a 5 minute gap starts a new run", () => {
    const rows = buildRows([], [a("a1", 1000), a("a2", 2000), step(3000), a("a3", 5000), { id: "o1", ts: 6000, kind: "owner", text: "hi" }, a("a4", 7000), a("a5", 7000 + RUN_MS + 1)], "all");
    expect(rows.map((r) => r.type)).toEqual(["assistant", "assistant", "step", "assistant", "owner", "assistant", "assistant"]);
    expect(runs(rows, day).map((r) => `${+r.first}${+r.last}`)).toEqual(["10", "01", "00", "11", "11", "11", "11"]);
  });
  test("messages group by sender and receiver; a new day breaks the run", () => {
    const m = (at: number, to: string): Msg => ({ id: at, from: "root", to, kind: "info", body: "hi", at });
    const rows = buildRows([m(1000, "a"), m(2000, "a"), m(3000, "b"), m(86_400_000 + 10, "b")], [], "messages");
    expect(runs(rows, day).map((r) => `${+r.first}${+r.last}`)).toEqual(["10", "01", "11", "11"]);
  });
});
