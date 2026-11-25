// Owner 8404: "add a configuration on chat setting that tool calls start always expanded". Off by default, kept per browser.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PREFS, parsePrefs } from "../web/src/chatPrefs";

test("tool calls start folded by default", () => {
  expect(DEFAULT_PREFS.toolsOpen).toBe(false);
  expect(parsePrefs(null).toolsOpen).toBe(false);
  expect(parsePrefs("not json").toolsOpen).toBe(false);
  expect(parsePrefs(JSON.stringify({ toolsOpen: "yes" })).toolsOpen).toBe(false);
});

test("the stored value is read back", () => {
  expect(parsePrefs(JSON.stringify({ toolsOpen: true })).toolsOpen).toBe(true);
  expect(parsePrefs(JSON.stringify({ ...DEFAULT_PREFS, toolsOpen: true, size: "l" }))).toMatchObject({ toolsOpen: true, size: "l" });
});

test("the composer settings carry the switch, and a trail's open state follows it", () => {
  const src = readFileSync(join(import.meta.dir, "..", "web", "src", "components", "AgentnetChat.vue"), "utf8");
  expect(src).toMatch(/class="sw sm" role="switch" :aria-checked="prefs\.toolsOpen"/);
  expect(src).toMatch(/flip\.value\.has\(w\.key\) !== prefs\.toolsOpen/);
});
