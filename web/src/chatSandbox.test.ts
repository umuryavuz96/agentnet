import { describe, expect, test } from "bun:test";
import { ACTIVATION_MS, HEIGHT_MAX, HEIGHT_MIN, MARK, SEND_MAX, clampHeight, judgeSend, readMessage, sandboxDoc, type SendFacts } from "./chatSandbox";

// A real click inside the frame, with the owner idle in the chat page: the one case that sends.
const click: SendFacts = { text: "Yes", fromFrame: true, active: true, focused: true, locked: false, canSend: true, sinceOwnInput: 60_000 };

describe("judgeSend: only a click in the frame sends", () => {
  test("a click in the frame sends", () => expect(judgeSend(click)).toBe("send"));
  test("a script that posts on its own is dropped: the browser reports no user action", () => {
    expect(judgeSend({ ...click, active: false })).toBe("drop");
    expect(judgeSend({ ...click, active: false, focused: false })).toBe("drop");
  });
  test("the user acted, but not in this frame: dropped", () => expect(judgeSend({ ...click, focused: false })).toBe("drop"));
  test("the owner just clicked or typed in the chat page: the chat asks before it sends", () => {
    expect(judgeSend({ ...click, sinceOwnInput: 0 })).toBe("confirm");
    expect(judgeSend({ ...click, sinceOwnInput: ACTIVATION_MS - 1 })).toBe("confirm");
    expect(judgeSend({ ...click, sinceOwnInput: ACTIVATION_MS })).toBe("send");
  });
  test("one answer per frame, and none once the owner answered", () => expect(judgeSend({ ...click, locked: true })).toBe("drop"));
  test("nothing goes out when the owner cannot send, or from another window", () => {
    expect(judgeSend({ ...click, canSend: false })).toBe("drop");
    expect(judgeSend({ ...click, fromFrame: false })).toBe("drop");
  });
  test("text limits: empty and over the limit are dropped, the limit itself goes", () => {
    expect(judgeSend({ ...click, text: "  \n " })).toBe("drop");
    expect(judgeSend({ ...click, text: "x".repeat(SEND_MAX + 1) })).toBe("drop");
    expect(judgeSend({ ...click, text: "x".repeat(SEND_MAX) })).toBe("send");
  });
});

describe("bridge messages", () => {
  test("only marked messages of the three known kinds are read", () => {
    expect(readMessage({ [MARK]: 1, t: "ready" })).toEqual({ t: "ready" });
    expect(readMessage({ [MARK]: 1, t: "size", h: 120.4 })).toEqual({ t: "size", h: 120.4 });
    expect(readMessage({ [MARK]: 1, t: "send", text: "hi" })).toEqual({ t: "send", text: "hi" });
    for (const bad of [null, "ready", { t: "ready" }, { [MARK]: 1, t: "eval", code: "1" }, { [MARK]: 1, t: "size", h: "9" }, { [MARK]: 1, t: "size", h: NaN }, { [MARK]: 1, t: "send", text: 5 }, { [MARK]: 2, t: "ready" }]) expect(readMessage(bad)).toBeNull();
  });
  test("height is kept between the floor and the cap", () => {
    expect(clampHeight(10)).toBe(HEIGHT_MIN);
    expect(clampHeight(300.2)).toBe(301);
    expect(clampHeight(99_999)).toBe(HEIGHT_MAX);
    expect(clampHeight(Infinity)).toBe(HEIGHT_MIN);
    expect(clampHeight("300")).toBe(HEIGHT_MIN);
  });
});

describe("sandboxDoc", () => {
  const theme = { mode: "light" as const, vars: { "--ink": "rgb(1, 2, 3)", "--bg": "#fff;}</style><script>alert(1)</script>", "--nope": "red" } };
  const doc = sandboxDoc("<p id=\"mine\">hi</p>", theme);
  test("the tokens come first, then the bridge, then the agent's markup as written", () => {
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("data-theme=\"light\"");
    expect(doc).toContain("--ink:rgb(1, 2, 3);");
    expect(doc.indexOf("window.agentnet=api")).toBeGreaterThan(doc.indexOf("--ink:"));
    expect(doc.indexOf("<p id=\"mine\">hi</p>")).toBeGreaterThan(doc.indexOf("window.agentnet=api"));
  });
  test("a token value cannot close the style block, and unknown tokens are left out", () => {
    expect(doc).not.toContain("</style><script>alert(1)");
    expect(doc).toContain("--bg:#fff/style");
    expect(doc).not.toContain("--nope");
  });
  test("the document names no host: nothing in it loads from the network", () => expect(sandboxDoc("", theme)).not.toMatch(/https?:\/\//));
});
