// The motion of the agent trail (map board 10-agent-trail: snap(), settle(), play(), replay()), on the rendered DOM.
// Vue draws the trail from the live row; these functions move what it drew. Transform and opacity only.
// A change runs in this order: 0 ms the old branch fades where it was and the check uncovers; 60 ms the steps below slide
// to their new place and the rail stretches with the gap; 300 ms the rail lights and the head runs to the next node;
// 560 ms that node grows; 600 ms its branch opens. The CSS in AgentTrail.vue holds the keyframe half of it.

const EASE = "cubic-bezier(.2,.8,.2,1)";
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const all = <T extends Element = HTMLElement>(el: ParentNode, sel: string) => Array.from(el.querySelectorAll<T>(sel));

/** What a change of the live row is, read from the trail before and after. In the live stream "task done" and "next task
 *  started" can land apart: "complete" plays the finish (and the arrival when both came together), "start" the arrival alone. */
export interface TrailSig { name: string; done: number[]; cur: number; check: number; rows: string[] }
export type TrailChange = { how: "agent" | "complete" | "start" | "gate" | "answer" | "tick"; from: number; to: number };
export function trailChange(o: TrailSig, n: TrailSig): TrailChange {
  if (n.name !== o.name) return { how: "agent", from: -1, to: -1 };
  const fresh = n.done.filter((i) => !o.done.includes(i));
  if (fresh.length) return { how: "complete", from: Math.max(...fresh), to: n.cur };
  if (n.cur !== o.cur && n.cur >= 0) return { how: "start", from: Math.max(-1, ...n.done.filter((i) => i < n.cur)), to: n.cur };
  return { how: n.check && !o.check ? "gate" : !n.check && o.check ? "answer" : "tick", from: -1, to: -1 };
}

interface Part { i: string; sel: string; node: HTMLElement; top: number; left: number; width: number }
export interface TrailSnap { top: Record<string, number>; branch: Record<string, boolean>; parts: Part[] }

/** Before a change: where each step sits (as drawn, so a change in mid-motion carries on from there) and the parts under it that may go. */
export function snap(el: Element | null): TrailSnap | null {
  const list = el?.querySelector(".tr-list"); if (!list) return null;
  const o = list.getBoundingClientRect(), s: TrailSnap = { top: {}, branch: {}, parts: [] };
  for (const li of all(list, ".tr-step")) {
    const i = li.dataset.i ?? ""; s.top[i] = li.getBoundingClientRect().top - o.top; s.branch[i] = li.classList.contains("tr-branch");
    for (const p of all(li, ".tr-sub, .tr-gate")) { const r = p.getBoundingClientRect();
      s.parts.push({ i, sel: p.classList.contains("tr-gate") ? ".tr-gate" : ".tr-sub", node: p.cloneNode(true) as HTMLElement, top: r.top - o.top, left: r.left - o.left, width: r.width }); }
  }
  return s;
}

/** After the change: steps slide from where they were to where they are now; the rail between two nodes stretches with the
 *  gap, so it never lets go of the node; a branch or question that went fades out where it was. */
export function settle(el: Element | null, was: TrailSnap | null, wait: number) {
  const list = el?.querySelector<HTMLElement>(".tr-list"); if (!list || !was || reduced()) return;
  const opt: KeyframeAnimationOptions = { duration: 320, delay: wait, easing: EASE, fill: "backwards" };
  const steps = all(list, ".tr-step"), y0 = list.getBoundingClientRect().top, dy: Record<string, number> = {};
  for (const li of steps) { const i = li.dataset.i ?? ""; dy[i] = i in was.top ? Math.round(was.top[i] - (li.getBoundingClientRect().top - y0)) : 0; }
  steps.forEach((li, n) => {
    const i = li.dataset.i ?? "", nx = steps[n + 1], d = dy[i];
    if (d) li.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }], opt);
    const g = nx ? dy[nx.dataset.i ?? ""] - d : 0; if (!g) return; // the gap to the next node is changing
    const tail = li.querySelector<HTMLElement>(".tr-tail"), h = tail ? tail.offsetHeight : li.offsetHeight, k = (h + g) / h; if (!h || k <= 0) return;
    const grow = { transform: `scaleY(${k})` };
    if (tail) tail.animate([grow, { transform: "none" }], opt);
    else if (was.branch[i]) li.animate([{ transform: grow.transform, opacity: 0 }, { opacity: 0.55, offset: 0.5 }, { transform: "none", opacity: 0.55 }], { ...opt, pseudoElement: "::before" }); // the straight rail comes back as the branch goes
    else li.animate([grow, { transform: "none" }], { ...opt, pseudoElement: "::before" });
  });
  for (const p of was.parts) {
    const li = list.querySelector(`.tr-step[data-i="${p.i}"]`); if (li?.querySelector(p.sel)) continue; // still there
    const n = p.node; n.classList.remove("arrive"); n.classList.add("tr-ghost"); n.setAttribute("aria-hidden", "true"); n.inert = true;
    n.style.top = p.top + "px"; n.style.left = p.left + "px"; n.style.width = p.width + "px";
    list.insertBefore(n, list.firstChild); // first, so the last step stays :last-child
    n.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-4px)" }], { duration: 160, easing: EASE, fill: "forwards" }).onfinish = () => n.remove();
  }
}

/** The light that runs down the rail from one node to the next (the CSS class holds the keyframes and the delay). */
export function runHead(el: Element | null, from: number, to: number) {
  const a = el?.querySelector<HTMLElement>(`.tr-step[data-i="${from}"]`), b = el?.querySelector<HTMLElement>(`.tr-step[data-i="${to}"]`), head = el?.querySelector<HTMLElement>(".tr-head");
  if (!a || !b || !head) return;
  head.style.setProperty("--from", a.offsetTop + 12 + "px"); head.style.setProperty("--to", b.offsetTop + 12 + "px");
  head.classList.remove("run"); void head.offsetWidth; head.classList.add("run");
}

/** A new row on the branch (a new call, a side job): it comes in by itself, nothing else moves. */
export function rowsIn(rows: Element[]) {
  if (reduced()) return;
  for (const r of rows) r.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: "ease-out", fill: "backwards" });
}

/* Replay: draw the whole trail from the top, in the order it happened. Node by node the rail grows down; at the running
   step the line curves out, runs through each branch row, curves back, then carries on to the waiting steps.
   Web Animations with fill "backwards", so every part stays hidden until its turn. A second call starts again. */
const replaying = new WeakMap<Element, Animation[]>();
export function replay(el: Element | null, wait = 0) {
  const list = el?.querySelector<HTMLElement>(".tr-list"); if (!el || !list) return;
  for (const x of replaying.get(el) ?? []) x.cancel();
  const run: Animation[] = []; replaying.set(el, run);
  let t = wait;
  const go = (n: Element | null, kf: Keyframe[], dur: number, at: number, pe?: string) => { if (n) run.push(n.animate(kf, { duration: dur, delay: at, easing: EASE, fill: "backwards", ...(pe ? { pseudoElement: pe } : {}) })); };
  const IN = [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], FADE = [{ opacity: 0 }, { opacity: 1 }];
  const DRAW = [{ transform: "scaleY(0)", transformOrigin: "top" }, { transform: "scaleY(1)", transformOrigin: "top" }];
  if (reduced()) { go(list, FADE, 300, t); return; }
  for (const li of all(list, ".tr-step")) {
    go(li.querySelector(".tr-div"), FADE, 180, t); // the "Added later" divider arrives with its step
    go(li.querySelector(".tr-node"), [{ opacity: 0, transform: "scale(.4)" }, { opacity: 1, transform: "none" }], 160, t);
    go(li.querySelector(".tr-t"), IN, 180, t + 20); go(li.querySelector(".tr-r"), FADE, 180, t + 40);
    t += 60;
    if (li.classList.contains("tr-branch")) {
      go(li.querySelector(".tr-stem"), DRAW, 120, t); t += 100;
      go(li.querySelector(".tr-br.in"), FADE, 140, t); t += 120;
      for (const r of all(li, ".tr-row")) { go(r, IN, 200, t); go(r, DRAW, 140, t + 100, "::after"); t += 130; }
      go(li.querySelector(".tr-br.out"), FADE, 140, t); t += 100;
      const gate = li.querySelector(".tr-gate"); go(gate, IN, 280, t); if (gate) t += 200;
      go(li.querySelector(".tr-tail"), DRAW, 160, t); t += 120;
    } else {
      go(li, DRAW, 120, t, "::before");
      if (li.classList.contains("done")) go(li.querySelector(".tr-lit"), DRAW, 120, t);
      t += 60;
    }
  }
}
