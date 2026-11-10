import { describe, expect, test } from "bun:test";
import { buildRows, feedItems, type FeedItem } from "./chatFeed";
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
