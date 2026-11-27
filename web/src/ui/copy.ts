/** Put text on the clipboard; the old way when the page may not use the clipboard API (plain http). */
export async function copy(text: string): Promise<boolean> {
  try { if (navigator.clipboard) { await navigator.clipboard.writeText(text); return true; } } catch { /* blocked: try the old way */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}
