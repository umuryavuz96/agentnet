// Files and pictures named in an agent's chat reply.
// GET /agentnet/agents/:name/file?path=<path>&lines=<n or a-b>  reads one file for the chat's file card and focus view;
//   with &probe=1 it answers only { found } (200 either way), for the file check that turns a path in a reply into a chip.
//   A relative path is read from the agent's project folder; an absolute one must be inside it. The real path (symlinks
//   resolved) must stay inside the folder, a `..` segment is refused, and so are secrets: any `.env*`, `.git`, `.ssh`, `.aws`
//   segment, key and certificate files. Only known text and code extensions and PNG, JPEG, GIF and WebP are served; text must
//   have no NUL byte, and at most TEXT_MAX bytes are read (the answer says `truncated`). Pictures are streamed with the type their
//   bytes say (sniff), never SVG. GET only, panel auth like the other panel reads. 404 for anything refused, with no hint which.
import type { Hono } from "hono";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { problem, type Env } from "../core/http";
import { inHome, realOf } from "../core/paths";
import { sniff } from "./chatImages";
import { NAME_RE } from "./routes";
import { live } from "./store";

export const TEXT_MAX = 200 * 1024;
const TEXT_EXT = new Set("ts tsx js jsx mjs cjs vue json jsonl md mdx txt css scss html yaml yml toml sh zsh py rs go swift kt java rb sql ini lock csv log conf plist svg".split(" "));
const IMG_TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const SECRET = /^(\.env.*|\.git|\.ssh|\.aws|\.gnupg|\.netrc|\.config|\.claude|\.local|Library|.*\.(pem|key|p12|pfx|crt|sqlite3?|db|db-wal|db-shm)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?)$/i;
const extOf = (p: string) => (basename(p).split(".").pop() ?? "").toLowerCase();

export type FileRead = { kind: "text"; path: string; total: number; from: number; to: number; text: string; truncated: boolean } | { kind: "image"; bytes: Uint8Array<ArrayBuffer>; type: string };

/** The file at `path` for an agent whose project folder is `base`, or null when it is missing, outside, a secret or not readable text or picture. */
export function readChatFile(base: string | null, path: string, lines?: string): FileRead | null {
  if (!base || !path || path.length > 400 || path.includes("\0")) return null;
  const segs = path.split(/[\\/]/);
  if (segs.includes("..") || segs.some((s) => SECRET.test(s))) return null;
  const abs = isAbsolute(path) ? resolve(path) : resolve(join(base, path));
  if (!inHome(abs, base)) return null;
  const real = realOf(abs);
  if (!real || real.split(/[\\/]/).some((s) => SECRET.test(s))) return null;
  const ext = extOf(real), isImg = ext in IMG_TYPE || ext === "jpeg";
  if (!isImg && !TEXT_EXT.has(ext)) return null;
  try {
    const st = statSync(real);
    if (!st.isFile()) return null;
    const cap = isImg ? 10 * 1024 * 1024 : TEXT_MAX;
    if (isImg && st.size > cap) return null;
    const n = Math.min(st.size, cap), buf = new Uint8Array(n), fd = openSync(real, "r");
    try { readSync(fd, buf, 0, n, 0); } finally { closeSync(fd); }
    if (isImg) { const k = sniff(buf); return k ? { kind: "image", bytes: buf as Uint8Array<ArrayBuffer>, type: IMG_TYPE[k]! } : null; }
    if (buf.includes(0)) return null;
    const all = new TextDecoder().decode(buf).replace(/\n$/, "").split("\n");
    const m = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(lines ?? "");
    const from = m ? Math.min(Math.max(1, all.length), Math.max(1, Number(m[1]))) : 1, to = m ? Math.min(all.length, Math.max(from, Number(m[2] ?? m[1]))) : all.length;
    return { kind: "text", path, total: all.length, from, to, text: all.slice(from - 1, to).join("\n"), truncated: st.size > TEXT_MAX };
  } catch { return null; }
}

export function chatFileRoutes(api: Hono<Env>) {
  api.get("/agentnet/agents/:name/file", (c) => {
    const name = String(c.req.param("name"));
    if (!NAME_RE.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    const r = live().find((a) => a.name === name);
    const f = readChatFile(r?.project ?? null, c.req.query("path") ?? "", c.req.query("lines") ?? undefined);
    // probe=1: the chat only asks whether the file is there (a path becomes a chip), so a miss is an answer, not a 404.
    if (c.req.query("probe") === "1") return c.json({ found: !!f }, 200, { "Cache-Control": "private, no-cache" });
    if (!f) return problem(c, 404, "Not Found", "no such file for this agent");
    if (f.kind === "image") return new Response(f.bytes, { headers: { "Content-Type": f.type, "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } });
    return c.json(f, 200, { "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" });
  });
}
