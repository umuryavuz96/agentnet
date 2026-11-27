// The git detail behind a reference chip in an agent's chat.
// GET /agentnet/agents/:name/ref?kind=msg&id=<message number>  reads one message's sender, recipient, kind, subject and time
//   (for a message older than the stream's snapshot).
// GET /agentnet/agents/:name/ref?kind=sha|pr|branch&id=<7-40 hex | PR number | branch>  reads one commit, pull request or branch. The agent's project
//   folder is asked first; agents often commit elsewhere, so then its terminal's folder and every folder an agent ran in, if
//   it is a git repository. The first that has it wins and the answer names it (folder name only). A short commit id is all
//   but unique; a pull request number is not, which is why the name is shown. Read only: fixed git and gh arguments passed as an array (never a shell string), the id checked by regex
//   first, no fetch, no checkout, no lazy fetch, and the folder's config cannot start a helper (fsmonitor, ext diff,
//   textconv, signature check). Anything that cannot be read answers 200 { available: false, reason }, so the chat says why
//   instead of showing an error. Only a bad name, kind or id is 422. Answers are cached for 60 s per folder, kind and id.
import type { Hono } from "hono";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { problem, type Env } from "../core/http";
import { NAME_RE } from "./routes";
import { all } from "./store";
import { terminalOf } from "./ownerChat";
import { messageRow } from "./stream";
import { realTmux, type Tmux } from "./windows";

export type RefKind = "sha" | "pr" | "branch";
export interface RefFile { path: string; add: number | null; del: number | null }
export interface CommitRef { sha: string; short: string; subject: string; body: string; author: string; date: string; branches: string[]; files: RefFile[]; filesChanged: number; insertions: number; deletions: number; pushed: boolean; hasRemote: boolean; /** the commit on the web: only for a pushed commit of a GitHub repository */ url?: string }
export interface PrChecks { total: number; passed: number; failed: number; pending: number; skipped: number }
export interface PrRef { number: number; title: string; state: "open" | "merged" | "closed" | "draft"; author: string; branch: string; base: string; url: string; checks: PrChecks; additions?: number; deletions?: number; changedFiles?: number; review?: "approved" | "changes" | "required" }
/** A branch against the repository's main branch; `url` only for a branch pushed to GitHub. */
export interface BranchRef { name: string; base: string; ahead: number; behind: number; latest: { sha: string; short: string; author: string; date: string; subject: string }; url?: string }
export type RefAnswer =
  | { available: true; kind: "sha"; id: string; /** the folder name of the repository it was found in */ repo: string; commit: CommitRef }
  | { available: true; kind: "pr"; id: string; repo: string; pr: PrRef }
  | { available: true; kind: "branch"; id: string; repo: string; branch: BranchRef }
  | { available: false; kind: RefKind; id: string; reason: string };

export const REF_ID: Record<RefKind, RegExp> = { sha: /^[0-9a-f]{7,40}$/, pr: /^[1-9]\d{0,5}$/,
  // starts with a letter or digit, so it can never read as an option; git allows no ".." in a name
  branch: /^(?!.*\.\.)[A-Za-z0-9](?:[\w./-]{0,150}[\w-])?$/ };
export const CACHE_MS = 60_000;
const CACHE_MAX = 1000, FILES_MAX = 200, BRANCH_MAX = 20, BODY_MAX = 4000, OUT_MAX = 2 * 1024 * 1024, TIMEOUT_MS = 8000;

export interface RunResult { status: number; out: string; err: string }
/** Runs one program with fixed arguments in `cwd`. `status` 127 = the program is not on this machine. */
export type Run = (cmd: string[], cwd: string) => Promise<RunResult>;

const which = (bin: string) => Bun.which(bin) ?? [`/opt/homebrew/bin/${bin}`, `/usr/local/bin/${bin}`, `/usr/bin/${bin}`].find((p) => existsSync(p)) ?? null;
export const realRun: Run = async ([bin, ...args], cwd) => {
  const path = which(bin!);
  if (!path) return { status: 127, out: "", err: "" };
  try {
    const p = Bun.spawn([path, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" } });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { status: await p.exited, out: out.slice(0, OUT_MAX), err: err.slice(0, 4000) };
  } catch { return { status: 1, out: "", err: "" }; }
};

const GIT = ["git", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "--no-pager"];

/** The folder name of the repository around `dir` (a bare one has no top level: then the folder's own name). */
const repoName = async (dir: string, run: Run) => basename((await run([...GIT, "rev-parse", "--show-toplevel"], dir)).out.trim() || dir);
const NOT_FOUND: Record<RefKind, string> = { sha: "No such commit in the agent's project folder", pr: "No such pull request in this repository", branch: "No such branch in the agent's project folder" };
const NOWHERE: Record<RefKind, string> = { sha: "No such commit in the agent's project folder or the other known repositories", pr: "No such pull request in the agent's project folder or the other known repositories", branch: "No such branch in the agent's project folder or the other known repositories" };
/** Reasons that would be the same in every folder. */
const SAME_EVERYWHERE = new Set(["git is not installed", "The GitHub CLI (gh) is not installed", "The GitHub CLI (gh) is not signed in"]);

/** The web address of a GitHub remote, without any login the address carries; null for every other host. */
export function webBase(remote: string): string | null {
  const m = /^(?:git@github\.com:|(?:https|ssh):\/\/(?:[^/@\s]*@)?github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}
const originWeb = async (dir: string, run: Run) => webBase((await run([...GIT, "remote", "get-url", "origin"], dir)).out);

async function branchRef(dir: string, id: string, run: Run): Promise<RefAnswer> {
  const no = (reason: string): RefAnswer => ({ available: false, kind: "branch", id, reason });
  const git = (...a: string[]) => run([...GIT, ...a], dir);
  const exists = async (ref: string) => (await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)).status === 0;
  const repo = await git("rev-parse", "--git-dir");
  if (repo.status === 127) return no("git is not installed");
  if (repo.status !== 0) return no("The agent's project folder is not a git repository");
  const pushed = await exists(`refs/remotes/origin/${id}`);
  const ref = await exists(`refs/heads/${id}`) ? `refs/heads/${id}` : pushed ? `refs/remotes/origin/${id}` : null;
  if (!ref) return no(NOT_FOUND.branch);
  const head = (await git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")).out.trim().replace(/^origin\//, "");
  let base = "";
  for (const b of [head, "main", "master"]) if (b && await exists(`refs/heads/${b}`)) { base = b; break; }
  if (!base) return no("This repository has no main branch to compare with");
  const [count, last] = await Promise.all([
    git("rev-list", "--left-right", "--count", `refs/heads/${base}...${ref}`),
    git("show", "-s", "--format=%H%x00%h%x00%an%x00%aI%x00%s", ref),
  ]);
  const n = /^(\d+)\s+(\d+)/.exec(count.out), p = last.out.replace(/\n$/, "").split("\0");
  if (!n || p.length < 5) return no("git could not read this branch");
  const web = pushed ? await originWeb(dir, run) : null;
  return { available: true, kind: "branch", id, repo: await repoName(dir, run), branch: {
    name: id, base, behind: Number(n[1]), ahead: Number(n[2]), latest: { sha: p[0]!, short: p[1]!, author: p[2]!, date: p[3]!, subject: p[4]! },
    ...(web ? { url: `${web}/tree/${id.split("/").map(encodeURIComponent).join("/")}` } : {}),
  } };
}

async function commitRef(dir: string, id: string, run: Run): Promise<RefAnswer> {
  const no = (reason: string): RefAnswer => ({ available: false, kind: "sha", id, reason });
  const git = (...a: string[]) => run([...GIT, ...a], dir);
  const repo = await git("rev-parse", "--git-dir");
  if (repo.status === 127) return no("git is not installed");
  if (repo.status !== 0) return no("The agent's project folder is not a git repository");
  const found = await git("rev-parse", "--verify", "--quiet", `${id}^{commit}`);
  const sha = found.out.trim();
  if (found.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return no(NOT_FOUND.sha);
  const [head, stat, refs, remotes] = await Promise.all([
    git("show", "-s", "--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%b", sha),
    // a merge is measured against its first parent: what it brought into the branch
    git("show", "--format=", "--numstat", "-z", "--no-renames", "--diff-merges=first-parent", "--no-ext-diff", "--no-textconv", sha),
    git("for-each-ref", "--contains", sha, "--format=%(refname)", "refs/heads", "refs/remotes"),
    git("remote"),
  ]);
  const p = head.out.split("\0");
  if (head.status !== 0 || p.length < 6) return no("git could not read this commit");
  const files: RefFile[] = [];
  let filesChanged = 0, insertions = 0, deletions = 0;
  for (const rec of stat.out.split("\0")) {
    const m = /^\n*(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    const add = m[1] === "-" ? null : Number(m[1]), del = m[2] === "-" ? null : Number(m[2]);
    filesChanged++; insertions += add ?? 0; deletions += del ?? 0;
    if (files.length < FILES_MAX) files.push({ path: m[3]!, add, del });
  }
  const names = refs.out.split("\n").filter(Boolean);
  const local = names.filter((n) => n.startsWith("refs/heads/")).map((n) => n.slice(11));
  const remote = names.filter((n) => n.startsWith("refs/remotes/") && !n.endsWith("/HEAD")).map((n) => n.slice(13));
  const web = remote.length ? await originWeb(dir, run) : null;
  // a commit on another remote only is not on origin's web pages
  const onWeb = web && remote.some((n) => n.startsWith("origin/"));
  return { available: true, kind: "sha", id, repo: await repoName(dir, run), commit: {
    sha: p[0]!, short: p[1]!, author: p[2]!, date: p[3]!, subject: p[4]!, body: p.slice(5).join("\0").trim().slice(0, BODY_MAX),
    branches: [...local, ...remote].slice(0, BRANCH_MAX), files, filesChanged, insertions, deletions, pushed: remote.length > 0, hasRemote: !!remotes.out.trim(), ...(onWeb ? { url: `${web}/commit/${p[0]}` } : {}),
  } };
}

/** gh's statusCheckRollup (check runs and commit statuses) as four counts. */
export function checksOf(rollup: unknown): PrChecks {
  const c: PrChecks = { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 };
  for (const x of Array.isArray(rollup) ? rollup as { status?: string; conclusion?: string; state?: string }[] : []) {
    const done = x.state ?? (x.status === "COMPLETED" ? x.conclusion : "PENDING");
    c.total++;
    if (done === "SUCCESS" || done === "NEUTRAL") c.passed++;
    else if (done === "SKIPPED") c.skipped++;
    else if (done === "PENDING" || done === "EXPECTED" || !done) c.pending++;
    else c.failed++;
  }
  return c;
}

async function prRef(dir: string, id: string, run: Run): Promise<RefAnswer> {
  const no = (reason: string): RefAnswer => ({ available: false, kind: "pr", id, reason });
  const remotes = await run([...GIT, "remote"], dir);
  if (remotes.status === 127) return no("git is not installed");
  if (remotes.status !== 0) return no("The agent's project folder is not a git repository");
  if (!remotes.out.trim()) return no("This repository has no remote");
  const r = await run(["gh", "pr", "view", id, "--json", "number,title,state,isDraft,url,author,headRefName,baseRefName,statusCheckRollup,additions,deletions,changedFiles,reviewDecision"], dir);
  if (r.status === 127) return no("The GitHub CLI (gh) is not installed");
  if (r.status !== 0) {
    if (/Could not resolve to a PullRequest|no pull requests? found/i.test(r.err)) return no(NOT_FOUND.pr);
    if (/gh auth login|authentication|HTTP 401/i.test(r.err)) return no("The GitHub CLI (gh) is not signed in");
    if (/none of the git remotes|not a github/i.test(r.err)) return no("The remote of this repository is not on GitHub");
    return no("gh could not read this pull request");
  }
  try {
    const j = JSON.parse(r.out) as { number: number; title: string; state: string; isDraft?: boolean; url: string; author?: { login?: string }; headRefName?: string; baseRefName?: string; statusCheckRollup?: unknown; additions?: number; deletions?: number; changedFiles?: number; reviewDecision?: string };
    if (!/^https:\/\//.test(j.url)) return no("gh gave no web address for this pull request");
    const state = j.state === "MERGED" ? "merged" : j.state === "CLOSED" ? "closed" : j.isDraft ? "draft" : "open";
    return { available: true, kind: "pr", id, repo: await repoName(dir, run), pr: { number: j.number, title: j.title, state, author: j.author?.login ?? "", branch: j.headRefName ?? "", base: j.baseRefName ?? "", url: j.url, checks: checksOf(j.statusCheckRollup), additions: j.additions, deletions: j.deletions, changedFiles: j.changedFiles,
      review: j.reviewDecision === "APPROVED" ? "approved" : j.reviewDecision === "CHANGES_REQUESTED" ? "changes" : j.reviewDecision === "REVIEW_REQUIRED" ? "required" : undefined } };
  } catch { return no("gh could not read this pull request"); }
}

/** One resolver with its own 60 s cache; requests for the same reference share one run. */
export function refResolver(run: Run = realRun, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; answer: Promise<RefAnswer> }>();
  return (dir: string | null | undefined, kind: RefKind, id: string): Promise<RefAnswer> => {
    const no = (reason: string): Promise<RefAnswer> => Promise.resolve({ available: false, kind, id, reason });
    if (!dir) return no("This agent has no project folder");
    if (!existsSync(dir)) return no("The agent's project folder is gone");
    const key = `${dir}\0${kind}\0${id}`, hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.answer;
    const answer = (kind === "sha" ? commitRef(dir, id, run) : kind === "pr" ? prRef(dir, id, run) : branchRef(dir, id, run));
    cache.delete(key); cache.set(key, { at: now(), answer });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    answer.catch(() => cache.delete(key));
    return answer;
  };
}

type Resolve = ReturnType<typeof refResolver>;
/** The agent's own folder first, then the others in order (read only when needed); the first repository that has it wins. */
export async function findRef(resolve: Resolve, own: string | null, others: () => string[], kind: RefKind, id: string): Promise<RefAnswer> {
  const first = await resolve(own, kind, id);
  if (first.available || SAME_EVERYWHERE.has(first.reason)) return first;
  let searched = false; // another repository was really asked and did not have it
  for (const dir of new Set(others())) {
    if (dir === own || !existsSync(dir)) continue;
    const a = await resolve(dir, kind, id);
    if (a.available || SAME_EVERYWHERE.has(a.reason)) return a;
    searched ||= a.reason === NOT_FOUND[kind];
  }
  return searched ? { available: false, kind, id, reason: NOWHERE[kind] } : first;
}

/** Where else an agent's work may be: the folder its terminal stands in, then every folder an agent ran in, newest first. */
export function knownFolders(name: string, tmux: Tmux = realTmux, agents: typeof all = all): string[] {
  const target = terminalOf(name, { tmux });
  const here = target ? tmux.run(["display-message", "-p", "-t", target, "#{pane_current_path}"]) : null;
  const ran = agents().sort((a, b) => b.spawnedAt - a.spawnedAt).map((a) => a.project);
  return [here?.code === 0 ? here.out.trim() : "", ...ran].filter((d): d is string => !!d);
}

/** The project folder on the agent's record: the running one, else the latest agent that had this name (its chat stays readable). */
const projectOf = (name: string): string | null => {
  const rows = all().filter((a) => a.name === name);
  return (rows.find((a) => a.life !== "gone" && a.life !== "failed") ?? rows.sort((a, b) => b.lifeSince - a.lifeSince)[0])?.project ?? null;
};

export function chatRefRoutes(api: Hono<Env>, resolve = refResolver(), project: (name: string) => string | null = projectOf, others: (name: string) => string[] = knownFolders) {
  api.get("/agentnet/agents/:name/ref", async (c) => {
    const name = String(c.req.param("name")), kind = c.req.query("kind") ?? "", id = c.req.query("id") ?? "";
    if (!NAME_RE.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    if (kind === "msg") {
      if (!/^[1-9]\d{0,8}$/.test(id)) return problem(c, 422, "Can't do that", "id must be a message number");
      const m = messageRow(Number(id));
      const answer = m ? { available: true, kind, id, msg: { from: m.from, to: m.to, kind: m.kind, subject: m.subject, at: m.at } } : { available: false, kind, id, reason: "No such message" };
      return c.json(answer, 200, { "Cache-Control": "private, no-cache" });
    }
    if (kind !== "sha" && kind !== "pr" && kind !== "branch") return problem(c, 422, "Can't do that", "kind must be sha, pr or branch");
    if (!REF_ID[kind].test(id)) return problem(c, 422, "Can't do that", kind === "sha" ? "id must be 7 to 40 hex characters" : kind === "pr" ? "id must be a pull request number" : "id must be a branch name");
    return c.json(await findRef(resolve, project(name), () => others(name), kind, id), 200, { "Cache-Control": "private, no-cache" });
  });
}
