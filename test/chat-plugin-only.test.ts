// Owner chat reaches an agent only through its agentnet plugin: no Move director, no "cannot type into" lock, and a send the
// plugin cannot take yet says so under the bubble.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "web", "src", "components", "AgentnetChat.vue"), "utf8");

test("the chat offers no Move director and never locks the box over a terminal", () => {
  expect(src).not.toMatch(/Move director|director\/move|NO_TERMINAL|noTerm|cannot type into/);
});

test("a waiting answer shows one muted line under the message, in place of the queue line", () => {
  expect(src).toMatch(/if \(j\.waiting\) waits\.value/);
  expect(src).toMatch(/v-if="row\.state === 'sent' && waits\.has\(row\.nonce \?\? ''\) && !gone" class="ac-wait"[^>]*><span>Waiting for \{\{ name \}\} to connect<\/span><\/p>/);
});

test("one Send now stands for every message that waits for the turn, with no line under each bubble", () => {
  expect(src.match(/>Send now<\/button>/g)).toHaveLength(1);
  expect(src).toMatch(/<div v-if="queued\.length" class="ac-q"/);
  expect(src).not.toMatch(/waits? for \$?\{\{? ?name ?\}?\}? to finish its step|messages? waits? for this turn/);
});

test("no wording says the message is typed into a terminal", () => {
  expect(src).not.toMatch(/Delivered to the terminal|Type it into the terminal/);
});
