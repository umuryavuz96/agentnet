// Canvas Motion "a step finishes": the tick uncovers, the rail fills down, a light runs to the next node, that node grows,
// its rows come in 30 ms apart. The rail fill and the grow never fired live because, right after step_done, the next
// (now open) step had no call yet, so railSteps left it out: the finished step was the last group (no rail segment under
// it) and there was no next node to grow.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { railSteps, type FeedItem, type PlanBit } from "../web/src/chatFeed";

const call = (id: string, ts: number): FeedItem => ({ id, kind: "step", ts, title: "Reading a.ts", status: "ok" }) as FeedItem;
const step = (n: number, status: PlanBit["status"], at?: number, end?: number): PlanBit => ({ n, job: 1, text: `step ${n}`, status, at, end, proofs: [] });

test("right after a step finishes, the open next step and the pending ones follow it on the rail", () => {
  const plan = [step(1, "done", 100, 200), step(2, "active", 200), step(3, "pending")];
  const g = railSteps([call("a", 150)], plan)!;
  expect(g.map((x) => [x.step?.n, x.step?.status, x.items.length])).toEqual([[1, "done", 1], [2, "active", 0], [3, "pending", 0]]);
});

test("a run that ends on the open step still lists only the pending steps after it", () => {
  const plan = [step(1, "done", 100, 200), step(2, "active", 200), step(3, "pending")];
  const g = railSteps([call("a", 150), call("b", 250)], plan)!;
  expect(g.map((x) => x.step?.n)).toEqual([1, 2, 3]);
  expect(g[1]!.items.length).toBe(1);
});

test("an old run whose next step is done too adds no empty steps", () => {
  const plan = [step(1, "done", 100, 200), step(2, "done", 200, 300), step(3, "active", 300)];
  expect(railSteps([call("a", 150)], plan)!.map((x) => x.step?.n)).toEqual([1]);
});

test("the four finish animations are bound to the finished and next steps, in the canvas order", () => {
  const cw = readFileSync(join(import.meta.dir, "..", "web", "src", "components", "ChatWork.vue"), "utf8");
  const rn = readFileSync(join(import.meta.dir, "..", "web", "src", "components", "chat", "RailNode.vue"), "utf8");
  // classes: finished step .fin + RailNode play=fin, next step .nx + RailNode play=grow
  expect(cw).toMatch(/fin: fin\?\.n === gn\(g\) && !!g\.step, nx: fin\?\.next === gn\(g\) && !!g\.step/);
  expect(cw).toMatch(/:play="fin\?\.n === gn\(g\) && g\.step \? 'fin' : fin\?\.next === gn\(g\) && g\.step \? 'grow' : null"/);
  // order: uncover at 0 (360 ms), fill and light at 300 (320 ms), grow at 560 (240 ms), rows from 660, 30 ms apart
  expect(rn).toMatch(/\.cov\{[^}]*animation:rn-uncover 360ms [^ ]+ 1 both/);
  expect(cw).toMatch(/\.st\.fin > \.sg\{animation:cw-fill 320ms \S+ 300ms/);
  expect(cw).toMatch(/\.lt\{[^}]*animation:cw-run 320ms \S+ 300ms/);
  expect(rn).toMatch(/\.grow \.ring\{animation:rn-grow 240ms \S+ 560ms/);
  expect(cw).toMatch(/fin\.value\.next === gn\(g\) \? 660 : 0\) \+ Math\.min\(i, 8\) \* 30/);
  // the finished step keeps its rail segment: it is not the last group any more
  expect(cw).toMatch(/<i v-if="stepped && gi < groups\.length - 1 && !\(g\.items\.length && !folded\(g\)\)" class="sg"/);
});
