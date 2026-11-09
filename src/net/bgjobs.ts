// Live job watcher (read-only): status, progress, log tail and outputs of background jobs, plus a guarded file server for
// previews. Cards live in the bgjobs folder as <id>.json (AGENTNET_BGJOBS, default $AGENTNET_HOME/bgjobs).
// Files are served ONLY from inside a job's declared outputs directories: realpath must stay inside, no dotfiles, size cap.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { extname, join, resolve, sep, basename } from "node:path";
import { homedir } from "node:os";
import type { Hono } from "hono";
import { dir } from "../core/config";
import { problem, type Env } from "../core/http";
import { rootOnly } from "../core/access";

export interface WatchCard {
  id: string; owner: string | null; pid: number; desc: string; log?: string; started: number;
  outputs?: string[];                                   // directories to watch (absolute or ~/…)
  progress?: { file?: string; lines?: boolean; total?: number }; // JSON {done,total,label}, or count lines of `file` against `total`
  total?: number;                                       // static total, counted against the number of output files
}
export type Kind = "image" | "video" | "audio" | "text" | "json" | "csv" | "pdf" | "other";
const KINDS: Record<string, Kind> = { ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".mp4": "video", ".mov": "video", ".webm": "video", ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".ogg": "audio",
  ".txt": "text", ".md": "text", ".log": "text", ".json": "json", ".jsonl": "json", ".csv": "csv", ".pdf": "pdf" };
export const kindOf = (name: string): Kind => KINDS[extname(name).toLowerCase()] ?? "other";
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".pdf": "application/pdf", ".json": "application/json", ".jsonl": "text/plain", ".csv": "text/plain", ".txt": "text/plain", ".md": "text/plain", ".log": "text/plain" };
export const MAX_FILE = 25 * 1024 * 1024;
const exp = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

/** The file inside one of the job's output roots, or null. Rejects "..", dotfiles/.env, symlinks leaving the root and anything over the cap. */
export function safeFile(roots: string[], rel: string): { path: string; size: number; mime: string } | null {
  if (!rel || rel.includes("\0") || rel.split(/[\\/]/).some((p) => p === ".." || p.startsWith("."))) return null;
  for (const r0 of roots) {
    const root = real(exp(r0)); if (!root) continue;
    const full = real(resolve(root, rel)); if (!full) continue;
    if (full !== root && !full.startsWith(root + sep)) continue;           // symlink or path escaped the root
    if (basename(full).startsWith(".")) continue;
    const st = statSync(full);
    if (!st.isFile() || st.size > MAX_FILE) continue;
    return { path: full, size: st.size, mime: MIME[extname(full).toLowerCase()] ?? "application/octet-stream" };
  }
  return null;
}

/** The last `n` lines of a file without reading all of it. */
export function tailLines(file: string, n = 30, bytes = 16_384): string[] {
  try {
    const size = statSync(file).size, fd = openSync(file, "r");
    const buf = Buffer.alloc(Math.min(bytes, size)); readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length)); closeSync(fd);
    const lines = buf.toString("utf8").split("\n"); if (size > buf.length) lines.shift();
    return lines.filter((l, i, a) => l !== "" || i < a.length - 1).slice(-n);
  } catch { return []; }
}

export interface OutFile { path: string; name: string; size: number; mtime: number; kind: Kind }
/** Newest-first output files (walks each declared root up to 4 levels, skips dotfiles, caps the count). */
export function listOutputs(roots: string[], limit = 60, kind?: string): { files: OutFile[]; count: number; kinds: Partial<Record<Kind, number>>; matched: number } {
  const all: OutFile[] = [];
  const walk = (root: string, dir: string, depth: number) => {
    let names: string[] = []; try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const full = join(dir, n); let st; try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue; // never list or follow links: they could point outside the output folder
      if (st.isDirectory()) { if (depth < 4) walk(root, full, depth + 1); }
      else if (st.isFile()) all.push({ path: full.slice(root.length + 1), name: n, size: st.size, mtime: st.mtimeMs, kind: kindOf(n) });
    }
  };
  for (const r of roots) { const root = real(exp(r)); if (root) walk(root, root, 0); }
  all.sort((a, b) => b.mtime - a.mtime);
  const kinds: Partial<Record<Kind, number>> = {}; for (const f of all) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
  const sel = kind ? all.filter((f) => f.kind === kind) : all; // file type filter over ALL outputs, not just the newest page
  return { files: sel.slice(0, limit), count: all.length, kinds, matched: sel.length };
}

/** {done,total,label}: from the job's progress file (JSON, or lines counted against a total), else outputs counted against `total`. */
export function progressOf(card: WatchCard, outputCount: number): { done: number; total: number | null; label: string | null } | null {
  const p = card.progress;
  if (p?.file) {
    const f = exp(p.file);
    try {
      const text = readFileSync(f, "utf8");
      if (p.lines) return { done: text.split("\n").filter(Boolean).length, total: p.total ?? card.total ?? null, label: null };
      const j = JSON.parse(text) as { done?: number; total?: number; label?: string };
      return { done: Number(j.done ?? 0), total: j.total != null ? Number(j.total) : card.total ?? null, label: j.label ?? null };
    } catch { /* fall through */ }
  }
  if (card.total) return { done: outputCount, total: card.total, label: null };
  return null;
}

/** The folder that holds the job cards. */
export const bgDirOf = () => process.env.AGENTNET_BGJOBS ?? dir("bgjobs");
export function readCard(id: string): WatchCard | null {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  try { return JSON.parse(readFileSync(join(bgDirOf(), `${id}.json`), "utf8")) as WatchCard; } catch { return null; }
}
function exitOf(id: string): number | null {
  try { const n = Number(readFileSync(join(bgDirOf(), `${id}.exit`), "utf8").trim()); return Number.isFinite(n) ? n : null; } catch { return null; }
}
export function jobDetail(id: string, now = Date.now(), opts: { kind?: string; limit?: number } = {}) {
  const card = readCard(id); if (!card) return null;
  const exit = exitOf(id), up = alive(card.pid);
  const status = exit === null ? (up ? "running" : "stopped") : exit === 0 ? "done" : "failed";
  const out = listOutputs(card.outputs ?? [], Math.min(Math.max(opts.limit ?? 60, 1), 500), opts.kind || undefined);
  return { id: card.id, owner: card.owner, desc: card.desc, status, exit, pidAlive: up, pid: card.pid, started: card.started, runtimeMs: now - card.started,
    progress: progressOf(card, out.count), log: card.log && existsSync(exp(card.log)) ? tailLines(exp(card.log), 30) : [], outputs: out.files, outputCount: out.count, outputKinds: out.kinds, outputMatched: out.matched, hasOutputs: !!card.outputs?.length };
}
export function jobList() {
  let files: string[] = []; try { files = readdirSync(bgDirOf()).filter((f) => f.endsWith(".json")); } catch { return []; }
  return files.map((f) => jobDetail(f.slice(0, -5))).filter((j): j is NonNullable<typeof j> => !!j).map(({ log: _l, outputs: _o, ...rest }) => rest).sort((a, b) => b.started - a.started).slice(0, 40);
}

/** GET /bgjobs, /bgjobs/:id (open reads like the other panel reads); /bgjobs/:id/file is root only because job outputs can hold anything. */
export function bgjobRoutes(api: Hono<Env>) {
  api.get("/bgjobs", (c) => c.json(jobList()));
  api.get("/bgjobs/:id", (c) => { const j = jobDetail(c.req.param("id"), Date.now(), { kind: c.req.query("kind"), limit: Number(c.req.query("limit")) || undefined }); return j ? c.json(j) : problem(c, 404, "Not Found", "No such job"); });
  api.get("/bgjobs/:id/file", rootOnly, (c) => {
    const card = readCard(c.req.param("id"));
    const f = card?.outputs?.length ? safeFile(card.outputs, c.req.query("path") ?? "") : null;
    if (!f) return problem(c, 404, "Not Found", "No such output file");
    return new Response(Bun.file(f.path), { headers: { "Content-Type": f.mime, "Cache-Control": "private, max-age=30", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox" } });
  });
}
