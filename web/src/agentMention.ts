// Agent names in chat text: a word that is exactly a known agent's name ("root", "designer-macmeng") becomes a placeholder
// `<span class="cx-agm" data-ag="name">name</span>` that AgentnetChatBody.vue fills with AgentMention.vue (mark, name,
// state dot, click opens that agent's chat). Pure: the name list comes in from the caller, so the tests need no store.
// Only whole tokens match: the character before must be the start, a space or opening punctuation, and the one after must
// not continue a name, a path, a file or an address. Code spans, fenced code, links and ui blocks are never touched.
import type { Tokens, TokenizerAndRendererExtension } from "marked";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** Characters that may stand right before a name (besides the start of the text). Not "[": a link's text must reach marked's
 *  link tokenizer whole, and extensions run before it. */
const LEAD = `\\s({"'\\u201c\\u2018,;:!?`;
const LEAD_RE = new RegExp(`[${LEAD}]`);
/** After the name: no name character, and no dot, slash or @ that goes on into a word (root.ts, root/x, root@host). */
const TAIL = `(?![\\w-]|[./@:][\\w])`;
const NAME_OK = /^[A-Za-z0-9][\w-]{0,63}$/;

let key = "";
let startRe: RegExp | null = null;
let atRe: RegExp | null = null;
const built = new Map<string, [RegExp, RegExp]>();

/** Set the names to match; returns a key that changes only when the set changes. An empty list turns mentions off. */
export function setMentionNames(names: readonly string[]): string {
  const list = [...new Set(names.filter((n) => NAME_OK.test(n)))].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const k = list.join(" ");
  if (k === key) return key;
  key = k;
  if (!list.length) { startRe = atRe = null; return key; }
  let re = built.get(k);
  if (!re) {
    const alt = list.map((n) => n.replace(/-/g, "\\-")).join("|");
    re = [new RegExp(`(^|[${LEAD}])(${alt})${TAIL}`, "g"), new RegExp(`^([${LEAD}]?)(${alt})${TAIL}`)];
    if (built.size > 20) built.clear();
    built.set(k, re);
  }
  [startRe, atRe] = re;
  return key;
}

/** Where the next mention starts in a text chunk. marked hands start() the chunk without its first character, so a match
 *  at index 0 has a left neighbour this cannot see: it is skipped, and the tokenizer takes it with its lead character. */
export function mentionStart(s: string): number | undefined {
  if (!startRe) return undefined;
  startRe.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = startRe.exec(s)); ) {
    const at = m.index + m[1]!.length;
    if (at > 0) return at;
    startRe.lastIndex = m.index + 1;
  }
  return undefined;
}

/** A mention at the very start of `src`, with the one lead character it may carry. `before`: the text just before `src`
 *  when known (marked splits "is_root" into "is", "_" and "root", so the tokenizer looks at the previous token). */
export function mentionAt(src: string, before = ""): { raw: string; lead: string; name: string } | null {
  if (!atRe) return null;
  const m = atRe.exec(src);
  if (!m) return null;
  if (!m[1] && before && !LEAD_RE.test(before.slice(-1))) return null;
  return { raw: m[0], lead: m[1]!, name: m[2]! };
}

export const mentionHtml = (name: string) => `<span class="cx-agm" data-ag="${esc(name)}">${esc(name)}</span>`;

export const mentionExt: TokenizerAndRendererExtension = {
  name: "cxAgent", level: "inline",
  start: (s) => mentionStart(s),
  tokenizer(src, tokens) {
    const m = mentionAt(src, tokens.at(-1)?.raw);
    if (m) return { type: "cxAgent", raw: m.raw, lead: m.lead, text: m.name };
  },
  renderer: (t) => esc(t.lead as string) + mentionHtml(t.text as string),
};

/** A link's own text stays text: mentions inside it go back to the words they were. */
export function unmention(tokens: Tokens.Generic[]): Tokens.Generic[] {
  return tokens.map((t) => (t.type === "cxAgent" ? ({ type: "text", raw: t.raw, text: esc(t.raw) } as Tokens.Generic) : t.tokens ? { ...t, tokens: unmention(t.tokens) } : t));
}
