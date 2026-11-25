// Owner ask: agentnet traffic (agent messages, service notices, plugin deliveries, the agent's own agentnet calls) shows as
// tool-call rows in the turn's trail, not as chat messages. The classifier (web/src/agentnetRows.ts) turns each into a step
// with tool "agentnet"; buildRows then folds them into work rows with the other calls.
import { describe, expect, test } from "bun:test";
import { agentnetFeed, callInput, callLabel, msgLabel } from "../web/src/agentnetRows";
import { buildRows, type FeedItem } from "../web/src/chatFeed";
import type { Msg } from "../web/src/net";

const msg = (id: number, from: string, to: string, at: number, subject?: string, body = "the body\nline two"): Msg => ({ id, from, to, kind: "info", body, at, subject: subject ?? null });
const call = (id: string, ts: number, tool: string, input: Record<string, unknown>, out = "ok"): FeedItem => ({ id, kind: "step", ts, title: `agentnet · ${tool}`, status: "ok", tool: "other", inp: JSON.stringify(input, null, 1), out });

describe("agentnet rows", () => {
  test("an incoming message is a trail row with its full body as Out", () => {
    const [r] = agentnetFeed([msg(7, "builder-x", "root", 1000, "status")], [], "all", "root");
    expect(r).toMatchObject({ kind: "step", tool: "agentnet", title: "Message from builder-x: status", out: "the body\nline two", ts: 1000 });
    expect(r!.inp).toContain("builder-x to root");
  });

  test("labels: notices, sends, reports, steps", () => {
    expect(msgLabel(msg(1, "agentnet", "root", 0, "review: 1 auto grade"), "root")).toBe("agentnet: review: 1 auto grade");
    expect(msgLabel(msg(1, "root", "builder-a", 0, undefined, "Yes, add the call"), "root")).toBe("Sent to builder-a: Yes, add the call");
    expect(callLabel("report", { state: "done" })).toBe("Reported done");
    expect(callLabel("step_done", {}, "1.2")).toBe("Step 1.2 done");
    expect(callLabel("inbox", {})).toBe("Read the inbox");
    expect(callInput('{\n "to": "root",\n "body": "clipped…')).toMatchObject({ to: "root" });
  });

  test("a delivery folds into its message; one with no message stays a row", () => {
    const items: FeedItem[] = [{ id: "d1", kind: "delivery", ts: 1100, msg: 7 }, { id: "d2", kind: "delivery", ts: 1200, msg: 99 }];
    const out = agentnetFeed([msg(7, "builder-x", "root", 1000)], items, "all", "root");
    expect(out.map((i) => i.title)).toEqual(["Message from builder-x: the body", "Message #99 delivered"]);
    expect(out.every((i) => i.kind === "step" && i.tool === "agentnet")).toBe(true);
  });

  test("the agent's own send call is the row for the message it sent (no double)", () => {
    const items = [call("s1", 5000, "send", { to: "builder-a", subject: "go" })];
    const out = agentnetFeed([msg(8, "root", "builder-a", 5200, "go")], items, "all", "root");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "s1", title: "Sent to builder-a: go", tool: "agentnet" });
  });

  test("step_done names the plan step it closed", () => {
    const out = agentnetFeed([], [call("c", 10_000, "step_done", { evidence: ["commit: abc"] })], "terminal", "root", [{ n: 2, job: 1, text: "x", status: "done", at: 1, end: 10_300, proofs: [] }]);
    expect(out[0]!.title).toBe("Step 1.2 done");
  });

  test("no chat message rows remain; a turn of only agentnet rows is one folded work row", () => {
    const owner: FeedItem = { id: "o", kind: "owner", ts: 0, text: "hi" };
    const reply: FeedItem = { id: "a", kind: "assistant", ts: 500, text: "on it" };
    const rows = buildRows([], agentnetFeed([msg(1, "builder-x", "root", 1000), msg(2, "agentnet", "root", 1100, "G149: not covered")], [owner, reply, { id: "d", kind: "delivery", ts: 1050, msg: 1 }], "all", "root"), "all");
    expect(rows.map((r) => r.type)).toEqual(["owner", "assistant", "work"]);
    const w = rows[2] as Extract<(typeof rows)[number], { type: "work" }>;
    expect(w.steps).toBe(2);
  });

  test("filters: messages = agentnet rows only, terminal = no message rows", () => {
    const items: FeedItem[] = [{ id: "a", kind: "assistant", ts: 1, text: "x" }, call("c", 2, "inbox", {})];
    const m = [msg(1, "builder-x", "root", 3)];
    expect(agentnetFeed(m, items, "messages", "root").map((i) => i.id)).toEqual(["c", "an:m:1"]);
    expect(agentnetFeed(m, items, "terminal", "root").map((i) => i.id)).toEqual(["a", "c"]);
  });
});
