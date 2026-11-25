import { expect, test } from "bun:test";
import { EASE, MS_IN, MS_OUT, RAMP_MS, fadeFrames, inset, moveFrames, sameRect } from "../web/src/ui/chatDock";

const dock = { left: 1368, top: 12, width: 520, height: 1024 }, full = { left: 0, top: 0, width: 1900, height: 1048 };

test("the box itself moves: geometry keyframes from the old rect to the new one, no scale and no opacity", () => {
  const k = moveFrames(dock, full, { borderRadius: "18px", boxShadow: "a" }, { borderRadius: "16px", boxShadow: "b" });
  expect(k).toHaveLength(2);
  expect(k[0]).toMatchObject({ left: "1368px", top: "12px", width: "520px", height: "1024px", right: "auto", bottom: "auto", borderRadius: "18px", boxShadow: "a" });
  expect(k[1]).toMatchObject({ left: "0px", top: "0px", width: "1900px", height: "1048px", borderRadius: "16px", boxShadow: "b" });
  for (const f of k) { expect(f.transform).toBeUndefined(); expect(f.opacity).toBeUndefined(); }
});

test("board timing", () => {
  expect([MS_IN, MS_OUT, EASE]).toEqual([260, 180, "cubic-bezier(.23,1,.32,1)"]);
});

test("sameRect ignores sub-pixel noise only", () => {
  expect(sameRect(dock, { ...dock, left: 1368.3 })).toBe(true);
  expect(sameRect(dock, { ...dock, width: 522 })).toBe(false);
});

test("float open/close: grows from a smaller own spot when no card; solid for the whole move, only a 30 ms ramp at the ends", () => {
  expect(inset({ left: 100, top: 100, width: 500, height: 600 })).toEqual({ left: 120, top: 124, width: 460, height: 552 });
  expect(RAMP_MS).toBeLessThan(40);
  expect(fadeFrames(0, "in", 300)).toEqual([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1 }]);
  expect(fadeFrames(1, "out", 300)).toEqual([{ opacity: 1 }, { opacity: 1, offset: 0.9 }, { opacity: 0 }]);
  // a press mid-run starts from the opacity on screen, so it turns round without a jump
  expect(fadeFrames(0.4, "in", MS_IN)[0]).toEqual({ opacity: 0.4 });
  expect((fadeFrames(1, "in", MS_IN)[1].offset as number) * MS_IN).toBeCloseTo(RAMP_MS);
  expect((1 - (fadeFrames(1, "out", MS_OUT)[1].offset as number)) * MS_OUT).toBeCloseTo(RAMP_MS);
});
