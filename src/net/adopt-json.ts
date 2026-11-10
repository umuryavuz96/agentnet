// Byte-exact edits of one member inside a big JSON file we do not own (~/.claude.json).
// We never re-serialise the file: we find the text span of one `"server": {...}` member and cut or insert only that span,
// so every other key stays byte-identical. The scanner only skips over values; it never keeps or logs them.

type Span = { key: string; keyStart: number; valStart: number; valEnd: number };

const WS = /[ \t\r\n]/;
const skipWs = (t: string, i: number) => { while (i < t.length && WS.test(t[i])) i++; return i; };

/** End index (exclusive) of the JSON string starting at i. */
function strEnd(t: string, i: number): number {
  if (t[i] !== '"') throw new Error("not a string");
  for (let j = i + 1; j < t.length; j++) { if (t[j] === "\\") j++; else if (t[j] === '"') return j + 1; }
  throw new Error("unterminated string");
}
/** End index (exclusive) of the JSON value starting at i. */
function valEnd(t: string, i: number): number {
  const c = t[i];
  if (c === '"') return strEnd(t, i);
  if (c === "{" || c === "[") {
    const close = c === "{" ? "}" : "]";
    let j = skipWs(t, i + 1);
    if (t[j] === close) return j + 1;
    for (;;) {
      if (c === "{") { j = strEnd(t, skipWs(t, j)); j = skipWs(t, j); if (t[j] !== ":") throw new Error("expected :"); j++; }
      j = valEnd(t, skipWs(t, j)); j = skipWs(t, j);
      if (t[j] === ",") { j++; continue; }
      if (t[j] === close) return j + 1;
      throw new Error("bad JSON");
    }
  }
  let j = i; while (j < t.length && !/[,\]}\s]/.test(t[j])) j++;
  if (j === i) throw new Error("bad JSON");
  return j;
}
/** The members of the object that starts at `at` (a `{`), with their spans. */
function members(t: string, at: number): { spans: Span[]; close: number } {
  if (t[at] !== "{") throw new Error("not an object");
  const spans: Span[] = [];
  let j = skipWs(t, at + 1);
  if (t[j] === "}") return { spans, close: j };
  for (;;) {
    const keyStart = skipWs(t, j), ke = strEnd(t, keyStart);
    const key = JSON.parse(t.slice(keyStart, ke)) as string;
    j = skipWs(t, ke); if (t[j] !== ":") throw new Error("expected :");
    const valStart = skipWs(t, j + 1), end = valEnd(t, valStart);
    spans.push({ key, keyStart, valStart, valEnd: end });
    j = skipWs(t, end);
    if (t[j] === ",") { j++; continue; }
    if (t[j] === "}") return { spans, close: j };
    throw new Error("bad JSON");
  }
}
/** Start offset of the object at `path` (keys from the root object). Null when a step is missing or not an object. */
function objectAt(t: string, path: string[]): number | null {
  let at = skipWs(t, 0);
  if (t[at] !== "{") return null;
  for (const k of path) {
    const m = members(t, at).spans.find((s) => s.key === k);
    if (!m || t[m.valStart] !== "{") return null;
    at = m.valStart;
  }
  return at;
}

/** Paths (from the root) of every object that holds a member `server` under an `mcpServers` object: top level and per project. */
export function mcpHolders(t: string, server: string): string[][] {
  const out: string[][] = [];
  const root = objectAt(t, []); if (root === null) return out;
  const has = (path: string[]) => { const at = objectAt(t, path); return at !== null && members(t, at).spans.some((s) => s.key === server); };
  if (has(["mcpServers"])) out.push(["mcpServers"]);
  const proj = objectAt(t, ["projects"]);
  if (proj !== null) for (const p of members(t, proj).spans) if (t[p.valStart] === "{" && has(["projects", p.key, "mcpServers"])) out.push(["projects", p.key, "mcpServers"]);
  return out;
}

/** Cut the member `key` out of the object at `path`. Returns the new text and the exact removed member text (`"key": value`). */
export function cutMember(t: string, path: string[], key: string): { text: string; raw: string } {
  const at = objectAt(t, path); if (at === null) throw new Error("no such object");
  const { spans } = members(t, at);
  const i = spans.findIndex((s) => s.key === key); if (i < 0) throw new Error("no such member");
  const s = spans[i], raw = t.slice(s.keyStart, s.valEnd);
  let from = s.keyStart, to = s.valEnd;
  if (i + 1 < spans.length) to = spans[i + 1].keyStart;            // drop the member, its comma and the gap up to the next key
  else if (i > 0) from = spans[i - 1].valEnd;                        // last member: drop the comma before it instead
  return { text: t.slice(0, from) + t.slice(to), raw };
}

/** Put a removed member back as the last member of the object at `path`. Throws when the object is gone or the key already exists. */
export function putMember(t: string, path: string[], key: string, raw: string): string {
  const at = objectAt(t, path); if (at === null) throw new Error("the object it came from is gone");
  const { spans, close } = members(t, at);
  if (spans.some((s) => s.key === key)) throw new Error("an entry with that name is already there");
  if (!spans.length) return t.slice(0, close) + raw + t.slice(close);
  const last = spans[spans.length - 1], nl = t.lastIndexOf("\n", last.keyStart);
  const indent = nl >= 0 && t.slice(nl, last.keyStart).trim() === "" ? t.slice(nl, last.keyStart) : " ";
  return t.slice(0, last.valEnd) + "," + indent + raw + t.slice(last.valEnd);
}
