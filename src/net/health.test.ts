import { expect, test } from "bun:test";
import { health, shortHome } from "./health";

test("shortHome: ~ when under the home folder, absolute otherwise", () => {
  expect(shortHome("/Users/a/.local/share/agentnet", "/Users/a")).toBe("~/.local/share/agentnet");
  expect(shortHome("/Users/a", "/Users/a")).toBe("~");
  expect(shortHome("/Users/ab/x", "/Users/a")).toBe("/Users/ab/x");
  expect(shortHome("/srv/agentnet", "/Users/a")).toBe("/srv/agentnet");
});
test("health carries home and never the full home path when under it", () => {
  const h = health();
  expect(typeof h.home).toBe("string");
  expect(h.home.startsWith("~") || h.home.startsWith("/")).toBe(true);
});
