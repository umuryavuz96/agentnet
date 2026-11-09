// Checks shared by the CLI, the web route and auto update. Refuses with a stable code; a test per code.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as g from "./git";
import { readLock } from "./lock";
import { cmp, fromPackage, newest, type Ver } from "./version";

export type RefuseCode = "not-git" | "bad-package" | "no-origin" | "origin-mismatch" | "dirty" | "branch" | "fetch" | "tag-moved" | "diverged" | "locked";
export type Pre =
  | { ok: true; current: Ver; target: Ver | null; targetCommit?: string }
  | { ok: false; reason: RefuseCode; hint: string; lockId?: string };

export interface PreOpts {
  /** Where $HOME/run/update.lock lives. Without it the lock is not checked. */
  home?: string;
  /** false: skip fetch, target and divergence (cheap local checks only, for the web status). */
  fetch?: boolean;
  /** Tests only: accept a file:// or path origin. Never set from env or HTTP. */
  allowLocalOrigin?: boolean;
}

const no = (reason: RefuseCode, hint: string, lockId?: string): Pre => ({ ok: false, reason, hint, ...(lockId ? { lockId } : {}) });

/** "owner/repo" from an https or ssh GitHub URL, else null. */
export function githubSlug(url: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** The repository agentnet may update from: AGENTNET_UPDATE_REPO, else package.json repository.url. */
export function expectedSlug(repo: string): string | null {
  const env = process.env.AGENTNET_UPDATE_REPO?.trim();
  if (env) return /^[\w.-]+\/[\w.-]+$/.test(env) ? env.toLowerCase() : null;
  try {
    const p = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    const u = typeof p.repository === "string" ? p.repository : p.repository?.url;
    return typeof u === "string" ? githubSlug(u) : null;
  } catch { return null; }
}

export function packageVersion(repo: string): Ver | null {
  try { return fromPackage(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version); } catch { return null; }
}

export const releaseBranch = (): string => process.env.AGENTNET_UPDATE_BRANCH?.trim() || "main";

export function preflight(repo: string, opts: PreOpts = {}): Pre {
  if (!existsSync(join(repo, ".git"))) return no("not-git", "This copy is not a git checkout. Reinstall from a clone.");
  const current = packageVersion(repo);
  if (!current) return no("bad-package", "package.json has no valid version.");
  const origin = g.originUrl(repo);
  if (!origin) return no("no-origin", "Add the official remote: git remote add origin https://github.com/umuryavuz96/agentnet.git");
  const local = !!opts.allowLocalOrigin && (origin.startsWith("file://") || origin.startsWith("/"));
  if (!local) {
    const want = expectedSlug(repo), have = githubSlug(origin);
    if (!want || have !== want) return no("origin-mismatch", `origin is ${origin}, expected ${want ?? "a GitHub repository in package.json"}.`);
  }
  if (g.isDirty(repo)) return no("dirty", "Commit or stash your changes first.");
  const br = g.branch(repo), rb = releaseBranch();
  if (br ? br !== rb : g.tagsAtHead(repo).length === 0) return no("branch", `Switch to ${rb}, or set AGENTNET_UPDATE_BRANCH.`);
  let target: Ver | null = null, targetCommit: string | undefined;
  if (opts.fetch !== false) {
    let remote: Map<string, string>;
    try { remote = g.originTags(repo); } catch (e) { return no("fetch", (e as Error).message); }
    const top = newest([...remote.keys()]);
    if (top && cmp(top, current) > 0) {
      const local = g.localTagSha(repo, top.tag);
      if (local && local !== remote.get(top.tag)) return no("tag-moved", `Tag ${top.tag} differs from origin. Delete the local tag and try again.`);
      if (!local) { try { g.fetchTag(repo, top.tag); } catch (e) { return no("fetch", (e as Error).message); } }
      target = top; targetCommit = g.tagCommit(repo, top.tag);
      if (!g.isAncestor(repo, g.headCommit(repo), targetCommit)) return no("diverged", `Your checkout has commits that are not in ${top.tag}. It cannot fast-forward.`);
    }
  }
  if (opts.home) {
    const l = readLock(opts.home);
    if (l) return no("locked", `An update is already running (job ${l.id}).`, l.id);
  }
  return { ok: true, current, target, ...(targetCommit ? { targetCommit } : {}) };
}
