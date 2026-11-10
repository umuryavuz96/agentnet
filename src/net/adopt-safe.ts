// Safety primitives for "adopt an existing workspace": what may be read, how text is redacted, hashing and atomic writes.
// One path policy (allowedRead) is used by the collector, the report validator and mirrored in the plugin scan gate.
import { closeSync, openSync, readSync, realpathSync, renameSync, statSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { redact } from "../core/redact";

export const MAX_READ_BYTES = 200 * 1024;
/** ~/.claude.json grows with every project and chat. It is read only for its MCP server entries, so it gets a bigger cap than other files. */
export const MAX_CLAUDE_JSON_BYTES = 16 * 1024 * 1024;
export const userClaudeJson = () => join(process.env.HOME ?? homedir(), ".claude.json");
export const capFor = (path: string) => (resolve(path) === userClaudeJson() ? MAX_CLAUDE_JSON_BYTES : MAX_READ_BYTES);

/** File names that are never read, whatever the folder. Compared against the base name, case-insensitive. */
export const DENY_NAMES: RegExp[] = [
  /^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /^id_rsa/i, /^id_ed25519/i, /\.kdbx$/i,
  /credentials/i, /secret/i, /token/i,
];
/** Folders (relative to home) that are never read. */
export const DENY_HOME_DIRS = [".ssh", ".aws", ".gnupg", "Library/Keychains", ".config/gcloud"];
/** Files (relative to home) that are never read. */
export const DENY_HOME_FILES = [".docker/config.json", ".npmrc", ".netrc"];

const home = () => process.env.HOME ?? homedir();
const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

/** Why a path may not be read, or null when it may. Resolves symlinks first; a missing path is not allowed. */
export function denyReason(path: string, roots: string[]): string | null {
  const abs = resolve(path);
  const r = real(abs);
  if (!r) return "path does not exist";
  const rr = roots.map((x) => real(resolve(x))).filter((x): x is string => !!x);
  if (!rr.some((x) => inside(r, x))) return "outside the scan roots";
  // check both the name given and the real target name, so a symlink called notes.txt -> .env is refused
  for (const p of [abs, r]) {
    const b = basename(p);
    if (DENY_NAMES.some((re) => re.test(b))) return `file name is on the deny list (${b})`;
  }
  const h = real(home()) ?? home();
  for (const d of DENY_HOME_DIRS) { const full = join(h, d); if (inside(r, full) || inside(abs, join(home(), d))) return `folder is on the deny list (~/${d})`; }
  for (const f of DENY_HOME_FILES) { if (r === join(h, f) || abs === join(home(), f)) return `file is on the deny list (~/${f})`; }
  if (inside(r, join(h, ".local/share/agentnet")) && /(^|\/)tokens[^/]*$/.test(r)) return "agentnet token file";
  return null;
}

/** True when `path` may be read for a scan: inside a root, not on the deny list, <= 200 KB, not binary. Directories pass the policy (size/binary only apply to files). */
export function allowedRead(path: string, roots: string[], maxBytes = MAX_READ_BYTES): boolean {
  if (denyReason(path, roots)) return false;
  try {
    const st = statSync(path);
    if (st.isDirectory()) return true;
    if (!st.isFile() || st.size > maxBytes) return false;
    const fd = openSync(path, "r");
    try { const b = Buffer.alloc(Math.min(4096, st.size)); readSync(fd, b, 0, b.length, 0); if (b.includes(0)) return false; } finally { closeSync(fd); }
    return true;
  } catch { return false; }
}

/** Redact secrets in a string leaving the collector. */
export const redactText = redact;

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
export const sha256Text = (s: string) => createHash("sha256").update(s).digest("hex");

/** Write via tmp file + rename, in the same folder, with the given mode. */
export function writeAtomic(path: string, text: string | Uint8Array, mode = 0o600): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}
