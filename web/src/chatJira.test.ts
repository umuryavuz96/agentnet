import { describe, expect, test } from "bun:test";
import { createMessage, draftSummary, madeCount, parseJira } from "./chatJira";
import { parseFence } from "./chatBlocks";

const base = { type: "jira", project: "AGN", tickets: [{ title: "Fix rail", kind: "bug", points: 2 }] };
describe("parseJira", () => {
  test("a ticket without a key is a draft", () => {
    const b = parseJira(base)!;
    expect(b.state).toBe("draft");
    expect(b.tickets[0]!.kind).toBe("bug");
  });
  test("all keyed is created, an error is refused", () => {
    expect(parseJira({ ...base, tickets: [{ title: "a", key: "agn-1" }] })!.state).toBe("created");
    const r = parseJira({ ...base, tickets: [{ title: "a", key: "AGN-1" }, { title: "b", error: "needs component" }] })!;
    expect(r.state).toBe("refused");
    expect(madeCount(r.tickets)).toBe(1);
  });
  test("rejects bad input", () => {
    expect(parseJira({ ...base, tickets: [] })).toBeNull();
    expect(parseJira({ ...base, project: "" })).toBeNull();
    expect(parseJira({ ...base, tickets: [{ kind: "bug" }] })).toBeNull();
    expect(parseJira({ ...base, state: "created" })).toBeNull(); // created with no key
  });
  test("cuts and cleans fields", () => {
    const b = parseJira({ ...base, tickets: [{ title: "x".repeat(500), kind: "weird", priority: "HIGH", labels: ["a", 3, ""], links: [{ rel: "Child of", key: "bad" }, { rel: "Relates to", key: "AGN-9" }] }] })!;
    expect(b.tickets[0]!.title.length).toBe(201);
    expect(b.tickets[0]!.kind).toBe("task");
    expect(b.tickets[0]!.priority).toBe("high");
    expect(b.tickets[0]!.labels).toEqual(["a", "3"]);
    expect(b.tickets[0]!.links).toEqual([{ rel: "Relates to", key: "AGN-9", title: undefined }]);
  });
  test("summary and message", () => {
    const ts = parseJira({ ...base, tickets: [{ title: "a", points: 3 }, { title: "b", points: 1 }] })!.tickets;
    expect(draftSummary(ts)).toBe("2 stories, 4 points");
    expect(createMessage(ts)).toBe("Create 2 tickets in Jira: a; b");
  });
});
describe("through the fence", () => {
  test("a jira fence is a block once registered", () => {
    expect(parseFence(JSON.stringify(base))?.[0]?.type).toBe("jira");
  });
});
