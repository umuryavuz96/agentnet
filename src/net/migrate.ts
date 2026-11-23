// `agentnet migrate one-folder` (docs/internal/one-folder/SPEC-step6-migration.md): move the tokens of agents that are not running,
// copy the souls and move the records into the §1 layout. Dry run by default; --apply writes a manifest first; --undo reverses it.
// Never moves a root.token, run/panel.token, server-launch.json, sessions or unknown files, never writes outside the home,
// never creates claude/base/.complete or a per-agent config dir. Every process read goes through `MigrateProcs`.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { agentRecordsDir, agentTokenFile } from "../core/layout";
import { assertInHome } from "../core/paths";

export interface MigrateProcs {
  /** Values of AGENTNET_TOKEN_FILE in the env of same-user processes. */
  envTokenFiles(): string[];
  /** True when some process has the file open. */
  isOpen(file: string): boolean;
}
const text = (cmd: string[]) => { try { const p = Bun.spawnSync(cmd, { stderr: "ignore" }); return new TextDecoder().decode(p.stdout); } catch { return ""; } };
/** The real machine: `ps -E` on macOS, /proc/<pid>/environ on Linux, `lsof -t <file>`. */
export function realMigrateProcs(): MigrateProcs {
  return {
    envTokenFiles() {
      const out: string[] = [], grab = (s: string) => { for (const m of s.matchAll(/(?:^|[\s\0])AGENTNET_TOKEN_FILE=([^\s\0]+)/g)) out.push(m[1]!); };
      if (process.platform === "linux") {
        const uid = process.getuid?.() ?? -1;
        for (const p of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) { try { if (statSync(`/proc/${p}`).uid === uid) grab(readFileSync(`/proc/${p}/environ`, "utf8")); } catch { /* gone or not ours */ } }
      } else { // ps -E appends the env after the arguments; -A for processes without a terminal too, then only this user's
        const uid = String(process.getuid?.() ?? -1);
        for (const l of text(["/bin/ps", "-A", "-E", "-ww", "-o", "uid=,command="]).split("\n")) { const m = /^\s*(\d+)\s(.*)$/.exec(l); if (m && m[1] === uid) grab(m[2]!); }
      }
      return out;
    },
    isOpen: (file) => text(["lsof", "-t", file]).trim().length > 0,
  };
}

export interface Move { kind: "token" | "soul" | "record"; from: string; to: string; size: number; sha: string; mode: number; copy: boolean; agentId?: string; /** token_file of the row before the move (a copied store still names the original home) */ oldTokenFile?: string | null }
export interface Skip { path: string; reason: string }
export interface Plan { root: string; moves: Move[]; skips: Skip[]; left: Skip[] }
export interface Manifest { id: string; root: string; at: number; moves: Move[]; dirsMade: string[]; dirsRemoved: { path: string; mode: number }[]; dbBackup: string }

const sha256 = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const files = (d: string) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort(); } catch { return []; } };
const dirs = (d: string) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; } };
const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const LIVE = new Set(["starting", "live", "stopping"]);

interface Row { id: string; name: string; token_hash: string | null; token_file: string | null; standing: number }
const dbFile = (root: string) => join(root, "data", "agentnet.db");
export const openDb = (root: string, readonly = true) => new Database(dbFile(root), readonly ? { readonly: true } : { readwrite: true });
const lifeOf = (d: Database, id: string): string | null => {
  try { const r = d.query("SELECT json FROM agent_status WHERE agent_id = ?").get(id) as { json: string } | null; return r ? (JSON.parse(r.json).life ?? null) : null; } catch { return null; }
};

/** What --apply would do. Writes nothing. */
export function planMigration(root: string, d: Database, procs: MigrateProcs): Plan {
  const moves: Move[] = [], skips: Skip[] = [], left: Skip[] = [];
  const stat = (f: string) => statSync(f);
  // tokens: run/agentnet/<name>.token of a non-archived row that is not running
  const tokDir = join(root, "run", "agentnet");
  const rows = d.query("SELECT id, name, token_hash, token_file, COALESCE(standing, 0) AS standing FROM agents WHERE archived_at IS NULL").all() as Row[];
  let envFiles: Set<string> | null = null;
  const env = () => (envFiles ??= new Set(procs.envTokenFiles().flatMap((f) => [f, real(f)])));
  for (const n of files(tokDir)) {
    const from = join(tokDir, n), m = /^(.+)\.token$/.exec(n);
    if (n === "root.token") { left.push({ path: from, reason: "root token: never moved" }); continue; }
    if (!m || !NAME.test(m[1]!)) { left.push({ path: from, reason: "not a token" }); continue; }
    const name = m[1]!, sha = sha256(from), value = readFileSync(from, "utf8"), h = (t: string) => createHash("sha256").update(t).digest("hex");
    // the token value is the authority (auth is by value); token_file may name another home when the store is a copy
    // the source is always <home>/run/agentnet/<name>.token, never the row's token_file: a row naming a file outside this home is
    // rewritten to the in-home path only because the in-home file exists and holds its token
    const row = rows.find((r) => r.name === name && (r.token_file === from || (!!r.token_hash && (r.token_hash === h(value) || r.token_hash === h(value.trim())))));
    if (!row) { left.push({ path: from, reason: "no agent row holds it" }); continue; }
    const why = LIVE.has(lifeOf(d, row.id) ?? "") ? "live row" : row.standing ? "standing" : env().has(from) || env().has(real(from)) ? "AGENTNET_TOKEN_FILE in a process env" : procs.isOpen(from) ? "file is open" : null;
    if (why) { skips.push({ path: from, reason: `running (${why}), moves on respawn` }); continue; }
    const to = agentTokenFile(name, root);
    if (existsSync(to)) { skips.push({ path: from, reason: `target exists: ${to}` }); continue; }
    const st = stat(from);
    moves.push({ kind: "token", from, to, size: st.size, sha, mode: st.mode & 0o777, copy: false, agentId: row.id, oldTokenFile: row.token_file });
  }
  // souls: copied, run/souls stays for running agents and the fallback
  const oldSouls = join(root, "run", "souls"), newSouls = join(root, "souls");
  for (const n of files(oldSouls)) {
    const from = join(oldSouls, n), to = join(newSouls, n), sha = sha256(from);
    if (existsSync(to)) { if (sha256(to) !== sha) skips.push({ path: from, reason: `target differs: ${to}` }); continue; }
    const st = stat(from); moves.push({ kind: "soul", from, to, size: st.size, sha, mode: st.mode & 0o777, copy: true });
  }
  // records: records/<name>/* to agents/<name>/records/
  for (const name of dirs(join(root, "records"))) {
    if (!NAME.test(name)) { left.push({ path: join(root, "records", name), reason: "not an agent name" }); continue; }
    for (const n of files(join(root, "records", name))) {
      const from = join(root, "records", name, n), to = join(agentRecordsDir(name, root), n);
      if (existsSync(to)) { skips.push({ path: from, reason: `target exists: ${to}` }); continue; }
      const st = stat(from); moves.push({ kind: "record", from, to, size: st.size, sha: sha256(from), mode: st.mode & 0o777, copy: false });
    }
  }
  return { root, moves, skips, left };
}

export function formatPlan(p: Plan): string[] {
  const rel = (f: string) => relative(p.root, f) || f;
  const out = p.moves.map((m) => `${m.copy ? "copy" : "move"} ${m.kind}  ${rel(m.from)} -> ${rel(m.to)}  ${m.size} B`);
  for (const s of p.skips) out.push(`skipped: ${rel(s.path)}  ${s.reason}`);
  for (const s of p.left) out.push(`left: ${rel(s.path)}  ${s.reason}`);
  const by = (k: Move["kind"]) => p.moves.filter((m) => m.kind === k).length;
  out.push(`total: ${by("token")} tokens, ${by("soul")} souls, ${by("record")} records to move; ${p.skips.length} skipped, ${p.left.length} left`);
  return out;
}

const backups = (root: string) => join(root, "backups");
const newId = (now: number) => new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-") + "-" + Math.random().toString(36).slice(2, 6);

/** Run the plan: manifest first, then the DB backup, then the moves, then token_file in one transaction. */
export function applyMigration(root: string, procs: MigrateProcs, now = Date.now()): { manifest: Manifest | null; plan: Plan } {
  const ro = openDb(root);
  let plan: Plan;
  try { plan = planMigration(root, ro, procs); } finally { ro.close(); }
  if (!plan.moves.length) return { manifest: null, plan };
  const id = newId(now), bdir = join(backups(root), `migrate-${id}`);
  for (const p of [backups(root), bdir]) { assertInHome(p, "migrate backup", root); if (!existsSync(p)) mkdirSync(p, { mode: 0o700 }); }
  const man: Manifest = { id, root, at: now, moves: plan.moves, dirsMade: [], dirsRemoved: [], dbBackup: join(bdir, "agentnet.db") };
  const mfile = join(bdir, "manifest.json");
  const save = () => { const t = mfile + ".tmp"; writeFileSync(t, JSON.stringify(man, null, 2) + "\n", { mode: 0o600 }); renameSync(t, mfile); };
  save(); // 1. the manifest, before anything moves
  const d = openDb(root, false);
  try {
    d.run("VACUUM INTO ?", [man.dbBackup]); // 2. online copy, safe while the server runs
    chmodSync(man.dbBackup, 0o600);
    const mkd = (dir: string) => { const missing: string[] = []; for (let x = dir; !existsSync(x); x = dirname(x)) missing.push(x); for (const x of missing.reverse()) { assertInHome(x, "migrate", root); mkdirSync(x, { mode: 0o700 }); man.dirsMade.push(x); } };
    for (const m of man.moves) { // 3. the moves; source and target both inside this home
      assertInHome(m.from, "migrate source", root); assertInHome(m.to, "migrate", root);
      mkd(dirname(m.to));
      if (m.copy) { copyFileSync(m.from, m.to); chmodSync(m.to, m.mode); } else renameSync(m.from, m.to);
      if (m.kind === "token") chmodSync(m.to, 0o600);
      save();
    }
    for (const name of dirs(join(root, "records"))) { const p = join(root, "records", name); if (!readdirSync(p).length) { man.dirsRemoved.push({ path: p, mode: statSync(p).mode & 0o777 }); rmdirSync(p); } }
    save();
    // 4. token_file of each moved agent, one transaction
    d.transaction(() => { for (const m of man.moves) if (m.kind === "token") d.run("UPDATE agents SET token_file = ? WHERE id = ?", [m.to, m.agentId!]); })();
  } finally { d.close(); }
  return { manifest: man, plan };
}

export interface UndoResult { ok: boolean; restored: string[]; refused: string[]; checked: number; kept: string[] }
/** Reverse a manifest: every move back, token_file back, then each restored file checked against its sha256 and mode. */
export function undoMigration(root: string, id: string, force = false): UndoResult {
  const mfile = join(backups(root), `migrate-${id}`, "manifest.json");
  if (!existsSync(mfile)) throw new Error(`no manifest for ${id}: ${mfile}`);
  const man = JSON.parse(readFileSync(mfile, "utf8")) as Manifest;
  const refused: string[] = [], restored: string[] = [];
  for (const m of man.moves) {
    if (!existsSync(m.to)) { refused.push(`${m.to}: missing`); continue; }
    if (sha256(m.to) !== m.sha) refused.push(`${m.to}: changed since the migration`);
  }
  if (refused.length && !force) return { ok: false, restored, refused, checked: 0, kept: [] };
  for (const r of [...man.dirsRemoved].reverse()) { assertInHome(r.path, "migrate undo", root); if (!existsSync(r.path)) mkdirSync(r.path, { mode: r.mode, recursive: true }); chmodSync(r.path, r.mode); }
  // souls/ is the live soul dir once it exists: when a spawn wrote into it after the migration, removing the copies would leave
  // souls/ without the director prompt and the older souls, so the copies stay and the fallback keeps working
  const soulTargets = new Set(man.moves.filter((m) => m.kind === "soul").map((m) => m.to)), soulsNew = join(root, "souls");
  const extra = files(soulsNew).filter((n) => !soulTargets.has(join(soulsNew, n)));
  const kept: string[] = [];
  for (const m of [...man.moves].reverse()) {
    if (!existsSync(m.to)) continue;
    assertInHome(m.from, "migrate undo", root);
    if (m.copy && extra.length && existsSync(m.from)) { kept.push(m.to); restored.push(m.from); continue; }
    if (m.copy) { if (existsSync(m.from) && sha256(m.from) === m.sha) unlinkSync(m.to); else { mkdirSync(dirname(m.from), { recursive: true, mode: 0o700 }); renameSync(m.to, m.from); } }
    else { mkdirSync(dirname(m.from), { recursive: true, mode: 0o700 }); renameSync(m.to, m.from); }
    chmodSync(m.from, m.mode); restored.push(m.from);
  }
  const d = openDb(root, false);
  try { d.transaction(() => { for (const m of man.moves) if (m.kind === "token") d.run("UPDATE agents SET token_file = ? WHERE id = ? AND token_file = ?", [m.oldTokenFile === undefined ? m.from : m.oldTokenFile, m.agentId!, m.to]); })(); } finally { d.close(); }
  for (const x of [...man.dirsMade].sort((a, b) => b.length - a.length)) { try { if (!readdirSync(x).length) rmdirSync(x); } catch { /* not empty or gone */ } }
  let checked = 0;
  for (const m of man.moves) { if (existsSync(m.from) && sha256(m.from) === m.sha && (lstatSync(m.from).mode & 0o777) === m.mode) checked++; else refused.push(`${m.from}: sha or mode differs after undo`); }
  return { ok: checked === man.moves.length, restored, refused, checked, kept: kept.length ? [`souls/ has ${extra.length} file(s) written after the migration: kept ${kept.length} soul copies there`] : [] };
}
