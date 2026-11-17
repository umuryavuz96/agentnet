import { expect, test } from "bun:test";
import { agoWords } from "./trail";
test("agoWords follows the board's R.ago", () => {
  expect(agoWords(0)).toBe("now");
  expect(agoWords(89_000)).toBe("now");
  expect(agoWords(90_000)).toBe("2 min ago");
  expect(agoWords(3_600_000)).toBe("1 h ago");
  expect(agoWords(86_400_000 * 3)).toBe("3 d ago");
});
