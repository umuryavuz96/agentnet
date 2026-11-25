import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrain } from "./brains";

const dir = mkdtempSync(join(tmpdir(), "brains-"));
writeFileSync(join(dir, "t.md"), `---\nname: t\ndescription: x\nversion: 1\nlessons:\n  - {"id":"t-l1","text":"Quote the proof line.","theme":"proof","status":"candidate"}\n---\nBody.\n`);
process.env.AGENTNET_BRAINS_DIR = dir;
afterEach(() => { delete process.env.AGENTNET_BRAIN_LESSONS; });
test("lessons load only with the flag", () => {
  expect(loadBrain("t").text).not.toContain("Quote the proof line.");
  process.env.AGENTNET_BRAIN_LESSONS = "1";
  expect(loadBrain("t").text).toContain("## Lessons\n- Quote the proof line.");
});
