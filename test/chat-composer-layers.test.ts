// Owner 8406: composer 8 px inside the panel's bottom and sides; the new-messages pill has no blue outline (8355).
// Owner 8410: the settings popover is the top layer (pill hidden while open) and sits 8 px above the composer, right edges
// lined up. Live check: compose.mjs measures inL/inR/inB = 8, gap = 8, rightAlign = 0, popover on top.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "web", "src", "components");
const chat = readFileSync(join(dir, "AgentnetChat.vue"), "utf8"), view = readFileSync(join(dir, "AgentChatView.vue"), "utf8");

test("panel and floating chat inset the composer 8 px", () => {
  expect(view).toMatch(/\.acv\.dock \.acv-chat :deep\(\.ac-box\),\.acv\.float \.acv-chat :deep\(\.ac-box\)\{--bx:8px;padding-bottom:8px\}/);
});

test("the unread pill keeps the neutral outline", () => {
  expect(chat).toMatch(/\.ac-latest\.has\{color:var\(--you\)\}/);
  expect(chat).not.toMatch(/\.ac-latest\.has\{[^}]*border-color/);
});

test("the settings popover is on top, 8 px above the composer, aligned to its right edge", () => {
  expect(chat).toMatch(/\.ac-box\.pop\{z-index:7\}/);
  expect(chat).toMatch(/\.ac-cfg\{position:absolute;right:var\(--bx\);bottom:calc\(100% \+ 8px\)/);
  expect(chat).toMatch(/v-if="!stick && !empty && !cfg"[^>]*ac-latest/);
});
