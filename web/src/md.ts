// Chat markdown: agent text to safe HTML. Two layers. (1) marked with every raw HTML token escaped, images turned into links,
// only http/https/mailto links, our own code and table wrappers. (2) DOMPurify with a short tag and attribute list.
// Without a DOM (no DOMPurify) renderMd fails closed to escaped plain text; mdParse is the pure layer the tests cover.
import DOMPurify from "dompurify";
import { Marked, Renderer, type Tokens } from "marked";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);
const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

const marked = new Marked({ gfm: true, breaks: true });
marked.use({
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) { return esc(text); },
    code({ text, lang }: Tokens.Code) {
      const l = (lang ?? "").match(/^[\w+#.-]{1,20}/)?.[0] ?? "";
      return `<div class="md-code"><div class="md-ch"><span>${esc(l || "text")}</span><button type="button" class="md-copy">Copy</button></div><pre><code>${esc(text)}</code></pre></div>\n`;
    },
    table(this: Renderer, token: Tokens.Table) { return `<div class="md-table">${Renderer.prototype.table.call(this, token)}</div>\n`; },
    link(this: Renderer, { href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      if (!SAFE_URL.test(href)) return text;
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image({ href, text }: Tokens.Image) {
      const label = esc(text || href);
      return SAFE_URL.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    },
    checkbox({ checked }: Tokens.Checkbox) { return `<span class="md-cb${checked ? " on" : ""}" role="img" aria-label="${checked ? "done" : "not done"}"></span> `; },
  },
});

/** Markdown to HTML with raw HTML escaped and unsafe links dropped. Pure: no DOM needed. */
export function mdParse(src: string): string {
  try { return marked.parse(src, { async: false }) as string; } catch { return `<p>${esc(src)}</p>`; }
}

const PURIFY = {
  ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "code", "pre", "a", "hr", "table", "thead", "tbody", "tr", "th", "td", "div", "span", "button"],
  ALLOWED_ATTR: ["href", "title", "class", "target", "rel", "type", "align", "start", "role", "aria-label"],
  ALLOWED_URI_REGEXP: SAFE_URL,
  ALLOW_DATA_ATTR: false,
};
let hooked = false;
const cache = new Map<string, string>();
const CACHE_MAX = 400;

/** Safe HTML for v-html. Cached by text: the timeline re-renders on every feed frame. */
export function renderMd(src: string): string {
  const hit = cache.get(src);
  if (hit != null) return hit;
  let out: string;
  if (!DOMPurify.isSupported) out = `<p>${esc(src)}</p>`;
  else {
    if (!hooked) {
      hooked = true;
      DOMPurify.addHook("afterSanitizeAttributes", (n) => { if (n.tagName === "A") { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener noreferrer"); } });
    }
    out = DOMPurify.sanitize(mdParse(src), PURIFY);
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(src, out);
  return out;
}
