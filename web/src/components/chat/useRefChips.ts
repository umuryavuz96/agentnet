// Reference chips that work (docs/CHAT-TEXT-MARKERS.md). One set of listeners on the chat, because the chips are v-html:
// a commit or pull request chip shows its card after 300 ms of hover (it stays while the pointer is on the chip or the
// card; Esc closes it) and opens on click; a message, step or job chip is a button only when the chat has that thing.
import { nextTick, onBeforeUnmount, onMounted, shallowRef, watch, type Ref } from "vue";
import { knownRef, loadRef, type LookKind, type RefAnswer } from "../../refLookup";
import { api } from "../../ui/api";

export const SHOW_MS = 300, HIDE_MS = 160;
export interface Card { kind: LookKind; id: string; rect: { left: number; top: number; bottom: number }; answer: RefAnswer | null }
export interface RefTargets {
  agent: () => string;
  /** What a message, step or job chip does, or null when there is nothing to open (the chip then stays plain). */
  local: (kind: "msg" | "step" | "job", id: string) => (() => void) | null;
  openCommit: (id: string) => void;
}
const CHIP = ".cx-ref[data-ref]";
const isLook = (k: string | undefined): k is LookKind => k === "sha" || k === "pr";

export function useRefChips(root: Ref<HTMLElement | null>, targets: RefTargets, version: () => unknown) {
  const card = shallowRef<Card | null>(null);
  let chip: HTMLElement | null = null, showT: ReturnType<typeof setTimeout> | undefined, hideT: ReturnType<typeof setTimeout> | undefined, frame = 0;
  const chipOf = (e: Event) => (e.target as Element | null)?.closest?.<HTMLElement>(CHIP + ".cx-act") ?? null;

  /** Make each chip a button when it can do something, plain when it cannot. */
  function decorate() {
    frame = 0;
    for (const el of root.value?.querySelectorAll<HTMLElement>(CHIP) ?? []) {
      const { ref: kind, id = "" } = el.dataset;
      const on = !el.parentElement?.closest("a,button") && (isLook(kind) || !!targets.local(kind as "msg" | "step" | "job", id));
      if (on === el.classList.contains("cx-act")) continue;
      el.classList.toggle("cx-act", on);
      if (on) { el.tabIndex = 0; el.setAttribute("role", kind === "pr" ? "link" : "button"); }
      else { el.removeAttribute("tabindex"); el.removeAttribute("role"); }
    }
    if (chip && !chip.isConnected) hide();
  }
  const later = () => { frame ||= requestAnimationFrame(decorate); };

  function show(el: HTMLElement) {
    clearTimeout(showT); clearTimeout(hideT);
    const kind = el.dataset.ref, id = el.dataset.id ?? "";
    if (!isLook(kind) || !el.isConnected) return;
    chip?.removeAttribute("aria-describedby");
    chip = el; el.setAttribute("aria-describedby", "ref-card");
    const r = el.getBoundingClientRect(), agent = targets.agent();
    const at = { kind, id, rect: { left: r.left, top: r.top, bottom: r.bottom } };
    card.value = { ...at, answer: knownRef(agent, kind, id) ?? null };
    void loadRef(agent, kind, id, api).then((answer) => { if (chip === el && card.value && agent === targets.agent()) card.value = { ...at, answer }; });
  }
  const close = () => { chip?.removeAttribute("aria-describedby"); chip = null; card.value = null; };
  function hide() { clearTimeout(showT); clearTimeout(hideT); close(); }
  // closes the card only: the pointer may be on the next chip by now, and its card is on the way
  const hideSoon = () => { clearTimeout(showT); clearTimeout(hideT); hideT = setTimeout(close, HIDE_MS); };
  const keep = () => clearTimeout(hideT);

  async function openPr(el: HTMLElement) {
    const agent = targets.agent(), id = el.dataset.id ?? "";
    const have = knownRef(agent, "pr", id);
    if (have?.available && have.kind === "pr") { window.open(have.pr.url, "_blank", "noopener"); return; }
    if (have) { show(el); return; }
    // the tab opens inside the click, or the browser blocks it; it gets its address when the answer is here
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    const a = await loadRef(agent, "pr", id, api);
    if (a.available && a.kind === "pr") tab?.location.replace(a.pr.url);
    else { tab?.close(); void nextTick(() => show(el)); }
  }
  function act(el: HTMLElement) {
    const kind = el.dataset.ref!, id = el.dataset.id ?? "";
    if (kind === "pr") { void openPr(el); return; }
    hide();
    if (kind === "sha") targets.openCommit(id); else targets.local(kind as "msg" | "step" | "job", id)?.();
  }

  const over = (e: PointerEvent) => {
    const el = chipOf(e);
    if (!el || e.pointerType === "touch" || !isLook(el.dataset.ref)) return;
    if (el === chip) { keep(); return; }
    clearTimeout(showT); showT = setTimeout(() => show(el), SHOW_MS);
  };
  const out = (e: PointerEvent) => { const el = chipOf(e); if (el && !el.contains(e.relatedTarget as Node | null)) hideSoon(); };
  const focus = (e: FocusEvent) => { const el = chipOf(e); if (el?.matches(":focus-visible")) show(el); };
  const blur = (e: FocusEvent) => { if (chipOf(e)) hideSoon(); };
  const click = (e: MouseEvent) => { const el = chipOf(e); if (el) { e.preventDefault(); act(el); } };
  const keydown = (e: KeyboardEvent) => { const el = chipOf(e); if (el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); act(el); } };
  // Esc closes the card first: this listener is added at set-up, before the chat's and the window's own Esc.
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && card.value) { e.preventDefault(); e.stopImmediatePropagation(); hide(); } };
  addEventListener("keydown", esc, true);
  // the owner scrolls: the card closes. A live chat that scrolls itself leaves it, so new output does not take it away.
  const scrolled = () => { if (card.value || showT) hide(); };

  const mo = typeof MutationObserver === "function" ? new MutationObserver(later) : null;
  const EVENTS = [["pointerover", over], ["pointerout", out], ["focusin", focus], ["focusout", blur], ["click", click], ["keydown", keydown]] as const;
  onMounted(() => {
    const el = root.value; if (!el) return;
    for (const [n, f] of EVENTS) el.addEventListener(n, f as EventListener);
    // a card is placed once, so scrolling by hand closes it
    for (const n of ["wheel", "touchmove"]) el.addEventListener(n, scrolled, { passive: true });
    mo?.observe(el, { childList: true, subtree: true });
    later();
  });
  watch(version, later, { flush: "post" });
  watch(targets.agent, hide);
  onBeforeUnmount(() => {
    const el = root.value;
    if (el) { for (const [n, f] of EVENTS) el.removeEventListener(n, f as EventListener); for (const n of ["wheel", "touchmove"]) el.removeEventListener(n, scrolled); }
    mo?.disconnect(); cancelAnimationFrame(frame); removeEventListener("keydown", esc, true); hide();
  });
  return { card, keep, hideSoon, hide };
}
