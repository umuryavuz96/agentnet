// Regression (#1165): a fresh load of #/hooks?starter=1 mounts the Add hook sheet with open=true from the start.
// A plain watch on props.open never fires for that first value, so the gallery stayed empty. No DOM test harness
// here, so this checks the source; the live check is a headless-Chrome load of the deep link.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the sheet's open watcher runs immediately, so a sheet mounted open loads its templates", () => {
  const src = readFileSync(join(import.meta.dir, "..", "web", "src", "pages", "HookAddSheet.vue"), "utf8");
  const m = /watch\(\(\) => props\.open,[\s\S]*?\n\}, (\{[^}]*\})\)/.exec(src);
  expect(m?.[1]).toContain("immediate: true");
  expect(src).toMatch(/if \(props\.starter && starterLeft\.value\.length\) await reviewStarter\(\)/);
});
