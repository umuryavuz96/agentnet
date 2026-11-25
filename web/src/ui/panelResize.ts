// Drag the left edge of an Agents side panel (agent or team) to change its width. One listener for every panel: a pointer
// within EDGE px of the left edge shows the resize cursor; a drag sets --sp-w on the panel (side-panel.css reads it). The width
// is kept per panel kind in localStorage and applied to the next panel of that kind. Double-click the edge to go back to the
// default. Not on the phone sheet or the chat's large view.
const EDGE = 8, MIN = 360, KEY = "agentnet.panelWidth.";
const KINDS = ["ap", "tp"];
export const DEFAULT_W = 440;

const kindOf = (el: Element) => KINDS.find((k) => el.classList.contains(k)) ?? null;
const live = (el: Element | null): el is HTMLElement => !!el && el.classList.contains("side-panel") && !el.classList.contains("sheet") && !el.classList.contains("wide") && !!kindOf(el);
const maxOf = (el: HTMLElement) => Math.max(MIN, (el.parentElement?.clientWidth ?? innerWidth) - 24);
const read = (k: string) => { try { const v = Number(localStorage.getItem(KEY + k)); return v >= MIN ? v : null; } catch { return null; } };
const write = (k: string, v: number | null) => { try { v == null ? localStorage.removeItem(KEY + k) : localStorage.setItem(KEY + k, String(Math.round(v))); } catch { /* private mode */ } };
const set = (el: HTMLElement, w: number | null) => (w == null ? el.style.removeProperty("--sp-w") : el.style.setProperty("--sp-w", `${Math.round(Math.min(maxOf(el), Math.max(MIN, w)))}px`));
/** The panel's own width when it is not in the large view: the narrow width the chat returns to. */
export const narrowWidth = (el: HTMLElement) => { const k = kindOf(el); return Math.min((k ? read(k) : null) ?? DEFAULT_W, maxOf(el)); };

const panelAt = (e: PointerEvent | MouseEvent): HTMLElement | null => {
  const el = (e.target as Element | null)?.closest?.(".side-panel") ?? null;
  if (!live(el)) return null;
  return e.clientX - el.getBoundingClientRect().left <= EDGE ? el : null;
};

export function installPanelResize() {
  // a new panel takes the width kept for its kind
  const apply = (root: ParentNode) => root.querySelectorAll?.(".side-panel").forEach((el) => { const k = kindOf(el); if (k && !(el as HTMLElement).style.getPropertyValue("--sp-w")) set(el as HTMLElement, read(k)); });
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n instanceof Element) { if (n.classList.contains("side-panel")) apply(n.parentElement ?? n); else apply(n); } }).observe(document.body, { childList: true, subtree: true });
  apply(document);

  let drag: { el: HTMLElement; right: number; id: number } | null = null, hot: HTMLElement | null = null;
  const cursor = (el: HTMLElement | null) => { if (hot === el) return; hot?.classList.remove("sp-edge"); hot = el; hot?.classList.add("sp-edge"); };
  document.addEventListener("pointermove", (e) => {
    if (drag) { set(drag.el, drag.right - e.clientX); return; }
    cursor(e.pointerType === "mouse" ? panelAt(e) : null);
  }, { passive: true });
  document.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const el = panelAt(e); if (!el) return;
    e.preventDefault();
    drag = { el, right: el.getBoundingClientRect().right, id: e.pointerId };
    el.classList.add("sp-drag"); document.documentElement.classList.add("sp-resizing");
    try { el.setPointerCapture(e.pointerId); } catch { /* fine */ }
  });
  const end = () => {
    if (!drag) return;
    const { el } = drag; drag = null;
    el.classList.remove("sp-drag"); document.documentElement.classList.remove("sp-resizing");
    const k = kindOf(el); if (k) write(k, el.getBoundingClientRect().width);
  };
  document.addEventListener("pointerup", end); document.addEventListener("pointercancel", end);
  document.addEventListener("dblclick", (e) => { const el = panelAt(e); if (!el) return; const k = kindOf(el); set(el, null); if (k) write(k, null); });
}
