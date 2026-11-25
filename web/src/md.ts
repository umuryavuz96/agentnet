// Chat markdown: agent text to safe HTML. Two layers. (1) marked with every raw HTML token escaped, web images turned into
// links and local ones into a path the file check can turn into a chip (alone on a line they are a picture card, chatBlocks.ts),
// only http/https/mailto links, our own code and table wrappers. (2) DOMPurify with a short tag and attribute list.
// Without a DOM (no DOMPurify) renderMd fails closed to escaped plain text; mdParse is the pure layer the tests cover.
import DOMPurify from "dompurify";
import { Marked, Renderer, type Tokens } from "marked";
import { markers, parseCallout, calloutHtml, codespanKind, esc, pathCode } from "./chatMarkers";
import { mentionExt, setMentionNames, unmention } from "./agentMention";
export { esc };

const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

const marked = new Marked({ gfm: true, breaks: true });
marked.use(markers);
marked.use({ extensions: [mentionExt] });
marked.use({
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) { return esc(text); },
    blockquote(this: Renderer, token: Tokens.Blockquote) {
      const c = parseCallout(token.text);
      if (!c) return Renderer.prototype.blockquote.call(this, token);
      return calloutHtml(c.kind, c.title, c.body ? marked.parse(c.body, { async: false }) as string : "", c.title ? marked.parseInline(c.title, { async: false }) as string : "");
    },
    table(this: Renderer, token: Tokens.Table) { return `<div class="md-table">${Renderer.prototype.table.call(this, token)}</div>\n`; },
    link(this: Renderer, { href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(unmention(tokens));
      if (!SAFE_URL.test(href)) return text;
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image({ href, text }: Tokens.Image) {
      const label = esc(text || href);
      if (codespanKind(href) === "file") return pathCode(href);
      return SAFE_URL.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    },
    checkbox({ checked }: Tokens.Checkbox) { return `<span class="md-cb${checked ? " on" : ""}" role="img" aria-label="${checked ? "done" : "not done"}"></span> `; },
  },
});

/** Markdown to HTML with raw HTML escaped and unsafe links dropped. Pure: no DOM needed. `agents`: names that become
 *  mention placeholders (agentMention.ts); none by default. */
export function mdParse(src: string, agents: readonly string[] = []): string {
  setMentionNames(agents);
  try { return marked.parse(src, { async: false }) as string; } catch { return `<p>${esc(src)}</p>`; }
}

const PURIFY = {
  ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "code", "pre", "a", "hr", "table", "thead", "tbody", "tr", "th", "td", "div", "span", "button", "b", "svg", "path", "circle", "rect", "line"],
  ALLOWED_ATTR: ["href", "title", "class", "target", "rel", "type", "align", "start", "role", "aria-label", "data-n", "data-path", "data-pq", "data-ag", "viewBox", "width", "height", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "d", "cx", "cy", "r", "x", "y", "x1", "x2", "y1", "y2", "rx", "ry", "aria-hidden"],
  ALLOWED_URI_REGEXP: SAFE_URL,
  // DOMPurify drops any attribute value that fails ALLOWED_URI_REGEXP unless it is listed here; only href is a URL.
  ADD_URI_SAFE_ATTR: ["start", "align", "type", "target", "rel", "data-n", "data-path", "data-pq", "data-ag", "viewBox", "width", "height", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "d", "cx", "cy", "r", "x", "y", "x1", "x2", "y1", "y2", "rx", "ry", "aria-hidden"],
  ALLOW_DATA_ATTR: false,
};
let hooked = false;
const cache = new Map<string, string>();
const CACHE_MAX = 400;

/** Safe HTML for v-html. Cached by text and agent names: the timeline re-renders on every feed frame. */
export function renderMd(src: string, agents: readonly string[] = []): string {
  const ck = setMentionNames(agents) + "\n" + src;
  const hit = cache.get(ck);
  if (hit != null) return hit;
  let out: string;
  if (!DOMPurify.isSupported) out = `<p>${esc(src)}</p>`;
  else {
    if (!hooked) {
      hooked = true;
      DOMPurify.addHook("afterSanitizeAttributes", (n) => { if (n.tagName === "A") { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener noreferrer"); } });
    }
    out = DOMPurify.sanitize(mdParse(src, agents), PURIFY);
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(ck, out);
  return out;
}
