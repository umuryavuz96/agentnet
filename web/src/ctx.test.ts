import { expect, test } from "bun:test";
import { ctxView } from "./ctx";

const ctx = { tokens: 100_000, window: 1_000_000, pct: 10 };
test("context divides by the compact window when the agent has one", () => {
  const v = ctxView({ context: ctx, compactWindow: 300_000 })!;
  expect(Math.round(v.pct)).toBe(33); expect(v.window).toBe(300_000); expect(v.model).toBe(1_000_000); expect(v.compact).toBe(true);
});
test("root and agents without a compact window keep the model window", () => {
  for (const cw of [undefined, null, 0]) { const v = ctxView({ context: ctx, compactWindow: cw })!; expect(Math.round(v.pct)).toBe(10); expect(v.compact).toBe(false); }
  expect(ctxView({ context: null, compactWindow: 300_000 })).toBeNull(); expect(ctxView(null)).toBeNull();
});
