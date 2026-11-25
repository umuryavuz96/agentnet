// Owner 8402: "tapping on images preview opens it on another tab instead it should just expand into page center and focus".
// The four chat picture previews keep a real href (middle/cmd-click still opens a tab) but a plain click opens FocusView.
// No DOM harness here: plainClick is checked directly and the four sites are checked in the source.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { plainClick, usePicFocus } from "../web/src/components/chat/picFocus";

const read = (f: string) => readFileSync(join(import.meta.dir, "..", "web", "src", "components", f), "utf8");

test("a plain click is taken, a modifier or middle click is left to the browser", () => {
  expect(plainClick({ button: 0 })).toBe(true);
  expect(plainClick({ button: 1 })).toBe(false);
  expect(plainClick({ button: 0, metaKey: true })).toBe(false);
  expect(plainClick({ button: 0, ctrlKey: true })).toBe(false);
  expect(plainClick({ button: 0, shiftKey: true })).toBe(false);
});

test("a plain click on a preview does not navigate: the default is prevented and the picture is in focus", () => {
  const MouseEventLike = class { button = 0; metaKey = false; ctrlKey = false; shiftKey = false; altKey = false; defaultPrevented = false; currentTarget = null; preventDefault() { this.defaultPrevented = true; } };
  (globalThis as { MouseEvent?: unknown }).MouseEvent ??= MouseEventLike;
  const e = Object.assign(Object.create((globalThis as unknown as { MouseEvent: { prototype: object } }).MouseEvent.prototype), new MouseEventLike());
  const pf = usePicFocus();
  pf.open(e, "/img?path=a.png", "a.png");
  expect(e.defaultPrevented).toBe(true);
  expect(pf.pic.value?.src).toBe("/img?path=a.png");
  const cmd = Object.assign(Object.create((globalThis as unknown as { MouseEvent: { prototype: object } }).MouseEvent.prototype), new MouseEventLike(), { metaKey: true });
  const pf2 = usePicFocus();
  pf2.open(cmd, "/img?path=a.png", "a.png");
  expect(cmd.defaultPrevented).toBe(false);
  expect(pf2.pic.value).toBe(null);
});

test("all four previews open FocusView and keep a real href", () => {
  const sites = [read("ChatWork.vue"), read("ChatBlock.vue"), read("AgentnetChat.vue")];
  const anchors = sites.flatMap((s) => s.match(/<a [^>]*role="button" aria-haspopup="dialog"[^>]*>/g) ?? []);
  expect(anchors.length).toBe(4);
  for (const a of anchors) { expect(a).toMatch(/:href="/); expect(a).toMatch(/@click="/); }
  for (const s of sites) expect(s).toMatch(/<FocusView v-if="pf\.pic\.value"/);
});
