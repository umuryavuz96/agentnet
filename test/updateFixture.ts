// A fake release setup in a temp dir: a bare origin, a seed clone that publishes releases, and a work clone that is the
// "install" under test. The work clone starts on v0.3.0; newer tags exist only on origin until fetched.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

export function sh(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

export interface Fixture {
  dir: string; origin: string; seed: string; work: string; home: string;
  /** Commit a release on the seed repo and push it: bumps package.json, adds a CHANGELOG section, tags vX.Y.Z. */
  release(version: string, note?: string): string;
}

const CHANGELOG_HEAD = "# Changelog\n\n";

export function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "an-upd-"));
  const origin = join(dir, "origin.git"), seed = join(dir, "seed"), work = join(dir, "work"), home = join(dir, "home");
  mkdirSync(home);
  sh(dir, "init", "--bare", "-b", "main", origin);
  sh(dir, "init", "-b", "main", seed);
  sh(seed, "remote", "add", "origin", origin);
  mkdirSync(join(seed, "web"));
  writeFileSync(join(seed, ".gitignore"), "node_modules/\nweb/dist/\nweb/dist.*/\n");
  writeFileSync(join(seed, "bun.lock"), "{}\n");
  writeFileSync(join(seed, "web", "vite.config.ts"), "export default {};\n");
  const pkg = (v: string) => JSON.stringify({ name: "agentnet", version: v, repository: { type: "git", url: "git+https://github.com/umuryavuz96/agentnet.git" } }, null, 2) + "\n";
  let log = "";
  const release = (version: string, note = `Release ${version}.`): string => {
    log = `## ${version}\n\n${note}\n\n` + log;
    writeFileSync(join(seed, "package.json"), pkg(version));
    writeFileSync(join(seed, "CHANGELOG.md"), CHANGELOG_HEAD + log);
    sh(seed, "add", "-A");
    sh(seed, "commit", "-m", `release ${version}`);
    const c = sh(seed, "rev-parse", "HEAD");
    sh(seed, "tag", `v${version}`);
    sh(seed, "push", "origin", "main", "--tags");
    return c;
  };
  release("0.3.0");
  sh(dir, "clone", "-b", "main", origin, work);
  // After the clone, publish the rest. The work clone has not seen them.
  release("0.3.1");
  sh(seed, "tag", "v0.4.0-rc1"); // an rc tag on the 0.3.1 commit: must be ignored
  sh(seed, "tag", "nightly");
  release("0.4.0");
  sh(seed, "push", "origin", "--tags");
  // The old web build, untracked like the real web/dist.
  mkdirSync(join(work, "web", "dist"), { recursive: true });
  writeFileSync(join(work, "web", "dist", "index.html"), "old build");
  return { dir, origin, seed, work, home, release };
}
