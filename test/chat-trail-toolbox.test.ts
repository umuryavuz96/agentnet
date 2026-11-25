// Owner 8413: "no need to say 8 calls, because square count also says the same thing, just put an icon on the beginning,
// toolbox icon". The folded trail starts with a toolbox icon; the count lives in the aria-label for screen readers.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "web", "src", "components", "TrailFold.vue"), "utf8");
const tpl = /<template>[\s\S]*<\/template>/.exec(src)?.[0] ?? "";

test("the folded trail shows a toolbox icon, not the call count text", () => {
  expect(tpl).toMatch(/<Icon name="toolbox" :size="16"/);
  expect(tpl).not.toMatch(/" calls?"/);
  expect(tpl).not.toMatch(/sq\.length \}\}/);
});

test("the aria-label still carries the count", () => {
  expect(tpl).toMatch(/:aria-label="label"/);
  expect(src).toMatch(/`\$\{sq\.value\.length\} tool \$\{sq\.value\.length === 1 \? "call" : "calls"\}/);
});
