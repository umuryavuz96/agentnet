// The sidebar's pure parts (reference: the Mac app, agentnet-mac Sources/Shell/Sidebar.swift): the remembered fold,
// its ⌃⌘S shortcut, the usage ring's colour and outline, and the account tile's initial.
const KEY = "agentnet.sideCollapsed";
type Store = Pick<Storage, "getItem" | "setItem">;
const store = (): Store | null => { try { return localStorage; } catch { return null; } };

export function readCollapsed(s: Store | null = store()): boolean { try { return s?.getItem(KEY) === "1"; } catch { return false; } }
/** Storage can be blocked: then the choice lasts until reload. */
export function writeCollapsed(v: boolean, s: Store | null = store()) { try { s?.setItem(KEY, v ? "1" : "0"); } catch { /* not remembered */ } }

/** Control Command S, the Mac app's "Show or Hide Sidebar". */
export const isFoldKey = (e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">) =>
  e.ctrlKey && e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyS";

/** Usage ring colour: green under 50 %, amber under 80 %, red from 80 %. */
export const ringColor = (pct: number) => (pct < 50 ? "var(--on)" : pct < 80 ? "var(--pend)" : "var(--bad)");

/** A capsule outline (a circle when w = h) that starts at the top centre and runs clockwise, so a dash reads as progress
 *  on the round icon and on the grown pill. Needs w >= h. */
export function capsulePath(w: number, h: number): string {
  const r = h / 2;
  return `M${w / 2} 0H${w - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 ${r} 0H${w / 2}`;
}

/** The account tile's letter: the server host's first letter; an IP address has none, so "A" (agentnet). */
export const accountInitial = (host: string) => (/^[a-z]/i.test(host) ? host[0].toUpperCase() : "A");

/** The 3D office keeps its screen place when a fold moves its box centre from `was` to `now` (px, `ppu` px per world
 *  unit): the camera target moves this far along the camera's right axis, then eases back to the new fit. */
export const holdShift = (was: number, now: number, ppu: number) => (now - was) / ppu;

/** Fold or grow with the sidebar's motion (components/Sidebar.vue styles): a view transition marked on <html>. Reduce
 *  Motion keeps the browser's short cross-fade; a browser without view transitions changes at once. */
export function foldTransition(fold: boolean, change: () => Promise<void>) {
  const doc = document as Document & { startViewTransition?: (cb: () => Promise<void>) => { ready: Promise<void> } };
  if (!doc.startViewTransition) { void change(); return; }
  clearTimeout(done);
  const root = document.documentElement;
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    root.dataset.sideAnim = fold ? "fold" : "grow";
    // the last icon starts 15 x 35 ms in and takes 450 ms
    done = setTimeout(() => delete root.dataset.sideAnim, 1100);
  } else delete root.dataset.sideAnim;
  // a skipped transition (hidden tab, a second press) still applies the change: nothing to report
  doc.startViewTransition(change).ready.catch(() => {});
}
let done: ReturnType<typeof setTimeout> | undefined;
