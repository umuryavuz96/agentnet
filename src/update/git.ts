// Thin git wrappers. Spawn without a shell, fixed argument lists. A tag reaches git only after parseTag accepted it,
// a commit only when it is a full hex id. Nothing from an HTTP body ever lands here.
import { parseTag } from "./version";

export interface GitResult { code: number; out: string; err: string }

export function git(repo: string, args: string[], timeoutMs = 60_000): GitResult {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe", stderr: "pipe", timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return { code: p.exitCode ?? 1, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

const must = (r: GitResult, what: string): string => {
  if (r.code !== 0) throw new Error(`${what}: ${(r.err || r.out).split("\n")[0] ?? "git failed"}`);
  return r.out;
};
const tagOk = (tag: string): string => {
  if (!parseTag(tag)) throw new Error(`not a release tag: ${tag}`);
  return tag;
};
const commitOk = (c: string): string => {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(c)) throw new Error(`not a commit id: ${c}`);
  return c;
};

export const headCommit = (repo: string): string => must(git(repo, ["rev-parse", "HEAD"]), "rev-parse HEAD");

/** Branch name, or null when HEAD is detached. */
export function branch(repo: string): string | null {
  const r = git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return r.code === 0 && r.out ? r.out : null;
}

/** Tracked changes only: a stray untracked file does not block a fast-forward. */
export const isDirty = (repo: string): boolean => git(repo, ["status", "--porcelain", "--untracked-files=no"]).out !== "";

/** The URL as written in the config, NOT `git remote get-url` (that expands url.<base>.insteadOf). The owner's own git
 *  config may point a github.com URL at a mirror or a local path for fetching; the slug check must still see what the
 *  checkout claims to be. Nothing in an HTTP request can reach git config. */
export function originUrl(repo: string): string | null {
  const r = git(repo, ["config", "--get", "remote.origin.url"]);
  return r.code === 0 && r.out ? r.out : null;
}

/** Release tags on ORIGIN (name -> object id), never local ones: a local `git tag v9.9.9` must not become a target. */
export function originTags(repo: string): Map<string, string> {
  const out = must(git(repo, ["ls-remote", "--tags", "--refs", "origin", "refs/tags/v*"], 120_000), "git ls-remote");
  const m = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [sha, ref] = line.split("\t");
    const tag = ref?.replace(/^refs\/tags\//, "");
    if (sha && tag && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) && parseTag(tag)) m.set(tag, sha);
  }
  return m;
}

/** Object id of a local tag, or null when there is none. */
export function localTagSha(repo: string, tag: string): string | null {
  const r = git(repo, ["rev-parse", "--verify", "-q", `refs/tags/${tagOk(tag)}`]);
  return r.code === 0 && r.out ? r.out : null;
}

/** Fetch exactly one tag. No --force, so a differing local tag fails loudly instead of being replaced. */
export function fetchTag(repo: string, tag: string): void {
  const t = tagOk(tag);
  must(git(repo, ["fetch", "--no-tags", "origin", `refs/tags/${t}:refs/tags/${t}`], 120_000), `git fetch ${t}`);
}

/** Release tags that point at HEAD. */
export const tagsAtHead = (repo: string): string[] => git(repo, ["tag", "--points-at", "HEAD"]).out.split("\n").filter((t) => parseTag(t));

export const tagCommit = (repo: string, tag: string): string => must(git(repo, ["rev-parse", `refs/tags/${tagOk(tag)}^{commit}`]), `rev-parse ${tag}`);

export const isAncestor = (repo: string, a: string, b: string): boolean => git(repo, ["merge-base", "--is-ancestor", commitOk(a), commitOk(b)]).code === 0;

/** On a branch: merge --ff-only. Detached: checkout --detach. Never creates a merge commit. */
export function fastForward(repo: string, tag: string): void {
  const ref = `refs/tags/${tagOk(tag)}`;
  must(branch(repo) ? git(repo, ["merge", "--ff-only", ref]) : git(repo, ["checkout", "--detach", ref]), `move to ${tag}`);
}

export function resetTo(repo: string, commit: string): void {
  const c = commitOk(commit);
  must(branch(repo) ? git(repo, ["reset", "--hard", c]) : git(repo, ["checkout", "--detach", c]), `reset to ${c.slice(0, 8)}`);
}

export function showFile(repo: string, rev: string, path: string): string | null {
  const r = git(repo, ["show", `${rev}:${path}`]);
  return r.code === 0 ? r.out : null;
}
