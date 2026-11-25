// The agent's text markers from the canvas (Syntax artboard), as pure HTML builders plus a marked extension that md.ts loads.
//   :ok[..] :warn[..] :bad[..] :info[..]   chip (max 40 chars)       ==text==   coloured text; alone on a line: key line
//   > [!NOTE|OK|WARN|BAD]                  callout card              #8931, step 1.2, job 14, PR #12, `839475a`   reference chips
//   `web/src/a.ts:47`                      file chip once checked    ```ts title=web/src/a.ts:30   code block header with numbers
//   AGN-388                                Jira key chip
// A marker that does not parse stays the text the agent typed. Every string that reaches HTML goes through esc().
import type { MarkedExtension, Tokens, TokenizerAndRendererExtension } from "marked";
import { iconSvg, type ChatIcon } from "./chatIcons";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

export type ChipTone = "ok" | "warn" | "bad" | "info";
export const CHIP_MAX = 40;

const chip = (cls: string, icon: ChatIcon | null, text: string, extra = "") =>
  `<span class="cx-chip ${cls}"${extra}>${icon ? iconSvg(icon) : ""}<b>${esc(text)}</b></span>`;
export const toneChip = (tone: ChipTone, text: string) => chip("cx-" + tone, null, text);
const REFS = {
  msg: "message-circle", step: "circle-dot", job: "clipboard-list", sha: "git-commit-horizontal", pr: "git-pull-request", file: "file-text",
} as const satisfies Record<string, ChatIcon>;
export const refChip = (kind: keyof typeof REFS, text: string, extra = "") => chip("cx-ref", REFS[kind], text, extra);

const SHA = /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,10}$/;
const EXTS = "ts|tsx|js|mjs|cjs|jsx|vue|json|md|css|scss|html|py|sh|zsh|yml|yaml|toml|rs|go|sql|txt|lock|png|jpg|jpeg|gif|svg|webp|swift|kt|rb|php|c|h|cpp|java|env|conf";
const PATH = new RegExp(`^(?:[\\w@~.+-]+/)*[\\w@.+-]+\\.(?:${EXTS})(?::\\d+(?:-\\d+)?)?$|^(?:~|\\.{1,2})?(?:/?[\\w@.+-]+/)+[\\w@.+-]*(?::\\d+(?:-\\d+)?)?$`, "i");

/** What a backticked span is: a short sha, a file path, or plain code (null). */
export function codespanKind(s: string): "sha" | "file" | null {
  if (SHA.test(s)) return "sha";
  if (s.length <= 120 && !/\s/.test(s) && PATH.test(s)) return "file";
  return null;
}
export const fileChip = (path: string) => refChip("file", path, ` data-path="${esc(path)}"`);
/** A path the page has not checked yet: plain code (canvas Files: "No chip, no card, no error") until checkFileChips finds it. */
export const pathCode = (path: string, label = path) => `<code class="cx-pq" data-pq="${esc(path)}">${esc(label)}</code>`;

// The file check: a path becomes a chip only when the service has the file under the agent's folder. One probe per agent and
// path; the answer is kept, so a feed frame that re-renders the text swaps the chip back in at once, with no second request.
const probed = new Map<string, boolean | Promise<boolean>>();
/** Turn every unchecked path code under `root` into a file chip when `exists` says the file is there. Each element once. */
export function checkFileChips(root: ParentNode, agent: string, exists: (path: string) => Promise<boolean>): void {
  for (const el of root.querySelectorAll<HTMLElement>("code.cx-pq[data-pq]:not([data-pc])")) {
    const path = el.dataset.pq!, file = path.replace(/:\d+(?:-\d+)?$/, ""), key = agent + "\n" + file;
    el.dataset.pc = "";
    const swap = (ok: boolean) => { if (ok && el.isConnected) el.outerHTML = fileChip(path); };
    let hit = probed.get(key);
    if (typeof hit === "boolean") { swap(hit); continue; }
    if (!hit) { hit = exists(file).catch(() => false).then((ok) => (probed.set(key, ok), ok)); probed.set(key, hit); }
    void hit.then(swap);
  }
}

// ---- Jira keys in prose: AGN-388. Words that look like keys but are standards or names stay text.
// marked asks start() with the first character cut off, so a match at index 0 has an unknown left neighbour and is skipped;
// a key right after an opening bracket or quote is taken with that character, so "(AGN-388)" still works.
const NOT_JIRA = new Set("UTF ISO SHA AES RFC GPT COVID HTTP TLS SSL IPV ECMA ANSI IEEE WCAG MP ES RGB HSL CVE SOC PCI GDPR AWS GCP USB HDMI PS LTE".split(" "));
const JIRA_RE = /^([(\["'\u201c\u2018]?)([A-Z]{2,10})-(\d{1,7})(?![\w-]|\.\d)/;
const jiraAt = (s: string) => { const m = JIRA_RE.exec(s); return m && !NOT_JIRA.has(m[2]!) ? m : null; };
const jiraExt: TokenizerAndRendererExtension = {
  name: "cxJira", level: "inline",
  start(s) {
    for (const m of s.matchAll(/[(\["'\u201c\u2018]?[A-Z]{2,10}-\d/g)) if (m.index! > 0 && !/[\w/.@#-]/.test(s[m.index! - 1]!) && jiraAt(s.slice(m.index))) return m.index;
  },
  tokenizer(src) {
    const m = jiraAt(src);
    if (m) return { type: "cxJira", raw: m[0], lead: m[1], text: m[0].slice(m[1]!.length) };
  },
  renderer: (t) => esc(t.lead as string) + jiraChip(t.text as string),
};
export const jiraChip = (key: string) => chip("cx-jira", "circle-dot", key);

// ---- inline extensions
const TONES = "ok|warn|bad|info";
const chipExt: TokenizerAndRendererExtension = {
  name: "cxChip", level: "inline",
  start: (s) => s.match(/:(?:ok|warn|bad|info)\[/)?.index,
  tokenizer(src) {
    const m = new RegExp(`^:(${TONES})\\[([^\\]\\n]{1,${CHIP_MAX}})\\]`).exec(src);
    if (m && m[2]!.trim()) return { type: "cxChip", raw: m[0], tone: m[1], text: m[2]!.trim() };
  },
  renderer: (t) => toneChip(t.tone as ChipTone, t.text as string),
};
const hlExt: TokenizerAndRendererExtension = {
  name: "cxHl", level: "inline",
  start: (s) => s.indexOf("=="),
  tokenizer(src) {
    const m = /^==(?=\S)([^\n]*?\S)==(?!=)/.exec(src);
    if (m && !m[1]!.includes("==")) return { type: "cxHl", raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]!) };
  },
  renderer(t) { return `<span class="cx-hl">${this.parser.parseInline(t.tokens ?? [])}</span>`; },
};
const REF_RE = /(?:\bPR #\d{1,6}|#\d{1,6}|\bstep \d{1,3}(?:\.\d{1,3})?|\bjob \d{1,6})(?![\w.]*\w|\d)/;
const refExt: TokenizerAndRendererExtension = {
  name: "cxRef", level: "inline",
  start(s) {
    for (const m of s.matchAll(/(?:PR #|#|\bstep |\bjob )\d/g)) if (m.index === 0 || !/[\w/&]/.test(s[m.index! - 1]!)) return m.index;
  },
  tokenizer(src) {
    const m = REF_RE.exec(src);
    if (m?.index === 0) return { type: "cxRef", raw: m[0], text: m[0] };
  },
  renderer(t) {
    const s = t.text as string;
    return refChip(s.startsWith("PR") ? "pr" : s.startsWith("#") ? "msg" : s.startsWith("step") ? "step" : "job", s);
  },
};

// ---- callouts
const CALLOUT_ICON: Record<string, ChatIcon> = { NOTE: "info", OK: "circle-check", WARN: "triangle-alert", BAD: "circle-x" };
/** `> [!OK] Title` (or the first line when more follow) becomes the title; the rest is the body (already HTML). */
export function parseCallout(inner: string): { kind: string; title: string; body: string } | null {
  const m = /^\[!(NOTE|OK|WARN|BAD)\][ \t]*([^\n]*)\n?/i.exec(inner);
  if (!m) return null;
  let title = m[2]!.trim(), body = inner.slice(m[0].length).trim();
  if (!title && body.includes("\n")) { const i = body.indexOf("\n"); title = body.slice(0, i).trim(); body = body.slice(i + 1).trim(); }
  return { kind: m[1]!.toUpperCase(), title, body };
}
export const calloutHtml = (kind: string, title: string, bodyHtml: string, titleHtml = esc(title)) =>
  `<div class="cx-callout ${kind === "NOTE" ? "cx-note" : "cx-" + kind.toLowerCase()}"><span class="cx-tile">${iconSvg(CALLOUT_ICON[kind] ?? "info", 16)}</span><div class="cx-cbody">${title ? `<b class="cx-ctitle">${titleHtml}</b>` : ""}${bodyHtml}</div></div>\n`;

// ---- code block
const FOLD_LINES = 8;
const KW = new Set("const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of type interface enum as readonly public private static void null undefined true false this def lambda None True False fn pub mut use impl struct func package go select echo then fi done".split(" "));
const hashComment = new Set(["sh", "bash", "zsh", "shell", "py", "python", "yaml", "yml", "toml", "rb", "ruby", "env"]);
/** One line to HTML: comment, string and keyword colours only. */
export function hlLine(line: string, lang: string): string {
  const cm = hashComment.has(lang) ? /#.*$/ : /\/\/.*$|^\s*\/?\*.*$/;
  const re = new RegExp(`(${cm.source})|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b([A-Za-z_]\\w*)\\b`, "g");
  let out = "", last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(line)); ) {
    const cls = m[1] ? "cx-c" : m[2] ? "cx-s" : KW.has(m[3]!) ? "cx-k" : "";
    if (!cls) continue;
    out += esc(line.slice(last, m.index)) + `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(line.slice(last));
}
/** `ts title=web/src/a.ts:30` into language, file and start line. */
export function parseFence(info: string | undefined): { lang: string; file: string; start: number | null } {
  const s = info ?? "";
  const lang = s.match(/^[\w+#.-]{1,20}/)?.[0] ?? "";
  const t = /\btitle=(\S{1,200})/.exec(s)?.[1] ?? "";
  const m = /^(.*?)(?::(\d{1,6}))?$/.exec(t)!;
  return { lang, file: m[1]!, start: m[2] ? Number(m[2]) : null };
}
export function codeHtml(text: string, info: string | undefined): string {
  const { lang, file, start } = parseFence(info);
  const l = lang.toLowerCase(), diff = l === "diff" || l === "patch";
  const rows = text.replace(/\n$/, "").split("\n");
  const num = file && start != null;
  const lines = rows.map((r, i) => {
    const body = diff ? esc(r) : hlLine(r, l);
    const cls = diff ? (r.startsWith("+") ? " cx-add" : r.startsWith("-") ? " cx-del" : "") : "";
    return `<span class="cx-ln${cls}"${num ? ` data-n="${start! + i}"` : ""}>${body}\n</span>`;
  }).join("");
  const cut = rows.length > FOLD_LINES;
  const name = file ? `<span class="cx-fn" data-path="${esc(file)}">${iconSvg("file-code", 13)}${esc(file)}${start != null ? `<i>:${start}</i>` : ""}</span>` : `<span class="cx-fn"></span>`;
  return `<div class="md-code${num ? " cx-num" : ""}${cut ? " cut" : ""}"><div class="md-ch">${name}<span class="cx-lang">${esc(lang || "text")}</span><button type="button" class="md-copy">${iconSvg("copy", 12)}<span>Copy</span></button></div><pre><code>${lines}</code></pre>${cut ? `<button type="button" class="md-more">${iconSvg("chevron-down", 13)}<span>Show all ${rows.length} lines</span></button>` : ""}</div>\n`;
}

/** Everything md.ts hands to marked.use(). */
export const markers: MarkedExtension = {
  extensions: [chipExt, hlExt, refExt, jiraExt],
  renderer: {
    code({ text, lang }: Tokens.Code) { return codeHtml(text, lang); },
    codespan(this: { parser: unknown }, tok: Tokens.Codespan) {
      const raw = tok.text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!);
      const k = codespanKind(raw);
      if (k === "sha") return refChip("sha", raw);
      if (k === "file") return pathCode(raw);
      return `<code>${tok.text}</code>`;
    },
    paragraph(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { tokens }: Tokens.Paragraph) {
      const one = tokens.length === 1 && tokens[0]!.type === "cxHl";
      if (one) return `<p class="cx-key">${this.parser.parseInline((tokens[0] as unknown as { tokens: Tokens.Generic[] }).tokens)}</p>\n`;
      // Bold words that open a paragraph are marked: a card block shows them as its title line (chatText.css .ub-card).
      const lead = tokens[0]?.type === "strong" ? `<strong class="cx-lead">${this.parser.parseInline((tokens[0] as Tokens.Strong).tokens)}</strong>` : "";
      return `<p>${lead}${this.parser.parseInline(lead ? tokens.slice(1) : tokens)}</p>\n`;
    },
  },
};
