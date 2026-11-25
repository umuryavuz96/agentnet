// Pictures in the owner's chat with an agent.
// POST /agentnet/agents/:name/image  (body = the image bytes, Content-Type image/png|jpeg|gif|webp, 10 MB at most) keeps a
//   picture the owner pasted into the composer under <home>/data/chat-images/<name>/ and answers its absolute path. The page
//   puts that path into the prompt, so the agent can read the file.
// GET  /agentnet/agents/:name/image?path=<absolute path>  serves a picture to the page, and only one of two kinds: a file this
//   route stored for that agent, or an image file that agent's own transcript shows it read (a Read tool call with that path)
//   or named as the `src` of an image block in a reply.
//   Either way the bytes must start like a PNG, JPEG, GIF or WebP, so no other file can come out of here, whatever its name.
// Panel auth; the POST is a panel write (mount.ts isPanelWrite).
import type { Hono } from "hono";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { dir } from "../core/config";
import { audit } from "../core/logger";
import { problem, type Env } from "../core/http";
import { inHome } from "../core/paths";
import { transcriptFor } from "./feed";
import { NAME_RE } from "./routes";
import { live } from "./store";

export const IMAGE_MAX = 10 * 1024 * 1024;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** What the first bytes say the file is: png, jpg, gif, webp, or null for anything else (SVG and HTML are never served). */
export function sniff(b: Uint8Array): keyof typeof TYPES | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

export const storeDir = (name: string, root = dir("data")) => join(root, "chat-images", name);

/** Keep one pasted picture. Returns its absolute path, or an error sentence. */
export function storeImage(name: string, bytes: Uint8Array, root?: string): { path: string } | { error: string } {
  if (!bytes.length) return { error: "the picture is empty" };
  if (bytes.length > IMAGE_MAX) return { error: "picture over 10 MB" };
  const kind = sniff(bytes);
  if (!kind) return { error: "not a PNG, JPEG, GIF or WebP picture" };
  const d = storeDir(name, root);
  mkdirSync(d, { recursive: true });
  const path = join(d, `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}.${kind}`);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return { path };
}

const seen = new Map<string, Set<string>>(); // transcript file -> image paths found in a Read call there
/** True when the agent's transcript holds a Read of exactly this path. A hit is remembered; a miss is looked up again (the file grows).
 *  The match is on the raw line: text that only quotes such a call (a prompt, a tool's output) sits inside a JSON string there,
 *  with its quotes escaped, so it cannot match. */
export function agentRead(transcript: string | null, path: string): boolean {
  if (!transcript) return false;
  const hit = seen.get(transcript) ?? new Set<string>();
  if (hit.has(path)) return true;
  let text = "";
  try { text = readFileSync(transcript, "utf8"); } catch { return false; }
  // read by the agent, or named by it as the `src` of an image block in a reply (there the reply is a JSON string, so its quotes are escaped)
  const q = JSON.stringify(JSON.stringify(path)).slice(1, -1);
  const ok = text.includes(`"name":"Read","input":{"file_path":${JSON.stringify(path)}`) || text.includes(`\\"src\\":${q}`) || text.includes(`\\"src\\": ${q}`);
  if (ok) { hit.add(path); seen.set(transcript, hit); }
  return ok;
}

/** The picture at `path` when the page may see it for this agent: [bytes, media type], or null. */
export function readableImage(name: string, path: string, transcript: string | null, root?: string): [Uint8Array<ArrayBuffer>, string] | null {
  if (!isAbsolute(path) || path.split(/[\\/]/).includes("..") || !IMAGE_EXT.test(path)) return null;
  if (!inHome(path, storeDir(name, root)) && !agentRead(transcript, path)) return null;
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > IMAGE_MAX) return null;
    const head = new Uint8Array(12), fd = openSync(path, "r");
    try { readSync(fd, head, 0, 12, 0); } finally { closeSync(fd); }
    const kind = sniff(head);
    return kind ? [new Uint8Array(readFileSync(path)), TYPES[kind]!] : null;
  } catch { return null; }
}

export function chatImageRoutes(api: Hono<Env>, root?: string) {
  const rowOf = (name: string) => live().find((a) => a.name === name);

  api.post("/agentnet/agents/:name/image", async (c) => {
    const name = String(c.req.param("name"));
    if (!NAME_RE.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    if (name !== "root" && !rowOf(name)) return problem(c, 404, "Not Found", "no live agent by that name");
    if (!/^image\/(png|jpeg|gif|webp)$/.test((c.req.header("content-type") ?? "").split(";")[0]!.trim())) return problem(c, 415, "Can't do that", "send a PNG, JPEG, GIF or WebP picture");
    if (Number(c.req.header("content-length") ?? 0) > IMAGE_MAX) return problem(c, 413, "Can't do that", "picture over 10 MB");
    const r = storeImage(name, new Uint8Array(await c.req.arrayBuffer()), root);
    if ("error" in r) return problem(c, r.error.includes("10 MB") ? 413 : 422, "Can't do that", r.error);
    audit(c.get("actor"), "agentnet.chat-image", name, "ok", c.get("trace"), {});
    return c.json({ agent: name, path: r.path });
  });

  api.get("/agentnet/agents/:name/image", (c) => {
    const name = String(c.req.param("name"));
    if (!NAME_RE.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    const r = rowOf(name), path = c.req.query("path") ?? "";
    const transcript = r || name === "root" ? transcriptFor({ session: r?.session ?? null, project: r?.project ?? null, pid: r?.pid ?? null, name }) : null;
    const img = existsSync(path) ? readableImage(name, path, transcript, root) : null;
    if (!img) return problem(c, 404, "Not Found", "no such picture for this agent");
    return new Response(img[0], { headers: { "Content-Type": img[1], "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } });
  });
}
