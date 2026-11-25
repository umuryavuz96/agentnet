// Regression (owner 8336, "I attached image in message but nothing here"): the owner bubble is a two-column grid
// (minmax(0,1fr) for content, auto for the send tick). The pasted picture sat in the 1fr column beside the text, so a long
// text took the auto column's whole width and squeezed the picture to 0 px. The picture row must span both columns.
// No DOM test harness here, so this checks the source; the live check pastes a picture with a long text and reads the
// picture's rendered width (0 px before, 260 px after).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "web", "src", "components", "AgentnetChat.vue"), "utf8");

test("the owner bubble's picture row spans the whole bubble, so a long text cannot squeeze it to 0 px", () => {
  const owner = /v-(?:else-)?if="row\.type === 'owner'"[\s\S]*?<\/article>/.exec(src)?.[0] ?? "";
  expect(owner).toMatch(/<p v-if="splitImages\(row\.text\)\.images\.length" class="ac-bp ac-span">/);
  expect(src).toMatch(/\.ac-m\.you \.ac-bub\{grid-template-columns:minmax\(0,1fr\) auto/);
  expect(src).toMatch(/\.ac-m\.you \.ac-span\{grid-column:1 \/ -1\}/);
});

test("a picture picked with the attach button goes the same way as a paste", () => {
  expect(src).toMatch(/function onPick\(e: Event\)[^\n]*addPics\(f\)/);
  expect(src).toMatch(/type="file" accept="image\/png,image\/jpeg,image\/gif,image\/webp"/);
});
