// The one-folder rule: agentnet writes only inside its home ($AGENTNET_HOME). A path the owner names in an env var
// (CLAUDE_SETTINGS_FILE, AGENTNET_HOOKS_DATA, ...) is the owner's choice and stays allowed; defaults never point outside.
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ROOT } from "./config";

/** Env vars whose value is a path the owner chose. A write there is allowed even outside the home. */
const OWNER_ENVS = new Set(["CLAUDE_SETTINGS_FILE", "AGENTNET_HOOKS_DATA", "HOOKS_DATA_DIR", "AGENTNET_HOOK_LOGS", "HOOK_LOG_DIR", "AGENTNET_USAGE_FILE"]);

/** The real path of `p`: realpath of the deepest existing parent, then the rest. null when a link on the way cannot be resolved
 *  (a dangling symlink could point anywhere, so it never counts as inside). */
export function realOf(p: string): string | null {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync(cur), ...rest.reverse()); } catch {
      try { lstatSync(cur); return null; } catch { /* does not exist: go up */ }
      const up = dirname(cur);
      if (up === cur) return null;
      rest.push(basename(cur)); cur = up;
    }
  }
}

const under = (p: string, base: string) => p === base || p.startsWith(base.endsWith(sep) ? base : base + sep);

/** True when `p` is inside `root` (default the home) after resolving symlinks. A path with a `..` segment is never inside. */
export function inHome(p: string, root: string = ROOT): boolean {
  if (p.split(/[\\/]/).includes("..")) return false;
  const r = realOf(root), t = realOf(p);
  return !!r && !!t && under(t, r);
}

/** Read an owner-chosen path from `env` and remember the variable, so the guard allows writes there. undefined when unset. */
export function allowOwnerPath(env: string): string | undefined {
  OWNER_ENVS.add(env);
  return process.env[env] || undefined;
}

/** Every owner-chosen path that is set and points outside the home (the server logs them once at boot). */
export function ownerPaths(root: string = ROOT): { env: string; path: string }[] {
  return [...OWNER_ENVS].flatMap((env) => { const v = process.env[env]; return v && !inHome(v, root) ? [{ env, path: v }] : []; });
}

/** The owner chose this path: it is an owner path, inside an owner folder, or a sibling of an owner file made from its name (backup, temp). */
function ownerChosen(p: string): boolean {
  const t = realOf(p); if (!t) return false;
  for (const env of OWNER_ENVS) {
    const v = process.env[env]; if (!v) continue;
    const o = realOf(v); if (!o) continue;
    if (under(t, o) || (dirname(t) === dirname(o) && basename(t).startsWith(basename(o) + "."))) return true;
  }
  return false;
}

export class OutsideHomeError extends Error {}
/** Throw unless `p` is inside the home or owner-chosen. `what` names the write in the message. */
export function assertInHome(p: string, what: string, root: string = ROOT): void {
  if (inHome(p, root) || ownerChosen(p)) return;
  throw new OutsideHomeError(`agentnet: refusing to write outside its folder: ${p} (${what})`);
}
