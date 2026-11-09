import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

/** Read KEY=VALUE lines from file into env, only for keys that are not already set.
 *  Skips blank lines and lines starting with #. No quotes, no expansion except a leading "~/" (becomes HOME + "/").
 *  A missing or unreadable file is a no-op. Returns the keys it set. */
export function loadEnvFile(file: string, env: Record<string, string | undefined> = process.env, home = homedir()): string[] {
  const set: string[] = [];
  let text: string;
  try { if (!existsSync(file)) return set; text = readFileSync(file, "utf8"); } catch { return set; }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    let v = line.slice(i + 1).trim();
    if (v.startsWith("~/")) v = home + v.slice(1);
    if (env[k] === undefined) { env[k] = v; set.push(k); }
  }
  return set;
}
