import { cmp, fromPackage, type Ver } from "./version";

/** The "## X.Y.Z" sections whose version is in (from, to], newest first, joined by a blank line. Unknown headings are skipped. */
export function sections(markdown: string, fromExclusive: Ver, toInclusive: Ver): string {
  const found: { v: Ver; text: string }[] = [];
  let cur: { v: Ver | null; lines: string[] } | null = null;
  const flush = () => { if (cur?.v) found.push({ v: cur.v, text: cur.lines.join("\n").trim() }); };
  for (const line of markdown.split("\n")) {
    const h = /^## (\S+)/.exec(line);
    if (h) {
      flush();
      cur = { v: fromPackage(h[1]!.replace(/^\[|\]$/g, "").replace(/^v/, "")), lines: [line] };
    } else if (/^# /.test(line)) { flush(); cur = null; }
    else cur?.lines.push(line);
  }
  flush();
  return found
    .filter(({ v }) => cmp(v, fromExclusive) > 0 && cmp(v, toInclusive) <= 0)
    .sort((a, b) => cmp(b.v, a.v))
    .map((s) => s.text)
    .join("\n\n");
}
