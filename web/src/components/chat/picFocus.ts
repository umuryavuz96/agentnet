// A picture preview in the chat opens large in place (FocusView), not in a new tab (owner 8402). The thumbnail keeps a real
// href so a middle-click or cmd/ctrl/shift-click still opens a tab; only a plain click (or Enter, which fires click) is taken.
import { ref } from "vue";

export type Origin = { x: number; y: number; w: number; h: number };
export type Pic = { src: string; path: string; origin: Origin | null };

type ClickLike = { button?: number; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; defaultPrevented?: boolean };

/** A plain click: left button, no modifier key. Anything else is left to the browser (new tab, download, ...). */
export function plainClick(e: ClickLike): boolean {
  return !e.defaultPrevented && (e.button ?? 0) === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** One picture in focus per component: `open(e, src, path)` on the thumbnail's click, FocusView v-if on `pic`. */
export function usePicFocus() {
  const pic = ref<Pic | null>(null);
  function open(e: MouseEvent | KeyboardEvent, src: string, path: string) {
    if (e instanceof MouseEvent && !plainClick(e)) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement | null;
    const img = el?.querySelector("img") ?? el;
    const r = img?.getBoundingClientRect();
    // Focus the thumbnail first: FocusView returns focus to whatever had it when it opened (Safari does not focus a clicked link).
    el?.focus?.({ preventScroll: true });
    pic.value = { src, path, origin: r && r.width ? { x: r.left, y: r.top, w: r.width, h: r.height } : null };
  }
  return { pic, open, close: () => { pic.value = null; } };
}
