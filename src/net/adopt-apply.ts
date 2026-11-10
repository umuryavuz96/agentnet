// Apply, backup and rollback for "adopt an existing workspace".
// applyPlan: refuse a stale plan, back up every file it will change (verified by sha), write the manifest, apply file by file,
// and on any failure put everything back. rollbackRun is a pure function over the manifest and the filesystem: it needs no server.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../core/config";
import { sha256File, writeAtomic } from "./adopt-safe";
import { computeChanges, planIdFor, type OpDesc, type Parked, type Plan } from "./adopt-plan";
import { registerSouls, removeSouls, wsDir } from "./workspace";

export const KEEP_RUNS = 5;
export interface FsOps { /** write a file atomically; tests make the Nth call fail */ write(path: string, text: string, mode: number): void }
export interface ApplyOpts { root?: string; /** repos named in the director prompt; default: the repos of the souls */ repos?: string[]; workspaceDir?: string; confirmGlobal?: boolean; builtinRoles?: string[]; fsOps?: Partial<FsOps>; now?: () => number }
export interface ManifestFile { file: string; /** null = the file did not exist before (created by the run) */ beforeSha: string | null; afterSha: string; backup: string | null; mode: number; opIds: string[] }
export interface Manifest {
  runId: string; createdAt: string; workspace: string; planId: string; state: "applying" | "applied" | "rolledback" | "failed";
  files: ManifestFile[]; ops: { id: string; op: string; file?: string; findingId: string | null; fromActions: string[] }[];
  /** soul files (and the catalog files) created by register-souls */ created: string[]; parked: Parked[];
  kept?: string[]; rolledBackAt?: string; error?: string;
}
export type ApplyResult = { ok: true; runId: string; manifest: Manifest; runDir: string } | { ok: false; status: 400 | 409 | 500; error: string; rolledBack?: boolean };
export interface RollbackResult { ok: boolean; runId: string | null; nothingToDo?: boolean; restored: string[]; removed: string[]; kept: { file: string; backup: string | null; why: string }[]; notes: string[]; error?: string }

const adoptDir = (root: string) => join(root, "adopt");
const manifestPath = (root: string, runId: string) => join(adoptDir(root), runId, "manifest.json");
const readManifest = (root: string, runId: string): Manifest | null => { try { return JSON.parse(readFileSync(manifestPath(root, runId), "utf8")) as Manifest; } catch { return null; } };
const saveManifest = (root: string, m: Manifest) => writeAtomic(manifestPath(root, m.runId), JSON.stringify(m, null, 2) + "\n", 0o600);
const shaOrNull = (f: string): string | null => { try { return existsSync(f) ? sha256File(f) : null; } catch { return null; } };
const mkdir700 = (d: string) => { mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700); };

/** The op descriptors a plan stands for (only the closed fields; nothing else from the plan object is trusted). */
export function descsOf(plan: Plan): OpDesc[] {
  return plan.ops.map((o): OpDesc => {
    if (o.op === "park-hook") return { op: o.op, file: o.file, event: o.event, matcher: o.matcher ?? null, commandIncludes: o.commandIncludes };
    if (o.op === "park-mcp") return { op: o.op, file: o.file, server: o.server };
    if (o.op === "disable-lines") return { op: o.op, file: o.file, fromLine: o.fromLine, toLine: o.toLine };
    if (o.op === "register-souls") return { op: o.op, repo: o.repo, name: o.name, source: o.source, ...(o.defFile ? { defFile: o.defFile } : {}), ...(o.roleClash ? { roleClash: true } : {}) };
    return { op: "write-director-prompt", file: o.file };
  });
}

let busy = false;

export async function applyPlan(plan: Plan, opts: ApplyOpts = {}): Promise<ApplyResult> {
  const root = opts.root ?? ROOT, wsd = opts.workspaceDir ?? wsDir(), now = opts.now ?? Date.now;
  const write = opts.fsOps?.write ?? ((p: string, t: string, m: number) => writeAtomic(p, t, m));
  if (busy) return { ok: false, status: 409, error: "another adopt run is in progress" };
  busy = true;
  try {
    if (planIdFor(plan) !== plan.planId) return { ok: false, status: 409, error: "The plan was changed after it was made. Preview again." };
    if (plan.needsConfirmGlobal && !opts.confirmGlobal) return { ok: false, status: 400, error: "The plan changes a global file (~/.claude). Confirm it to continue." };
    if (existsSync(join(adoptDir(root), plan.runId))) return { ok: false, status: 409, error: `run ${plan.runId} already exists. Preview again.` };

    // 1. stale check: the files must still be what the preview saw, and recomputing must give the same result
    const descs = descsOf(plan);
    for (const f of plan.files) if (shaOrNull(f.file) !== f.beforeSha) return { ok: false, status: 409, error: `${f.file} changed since the preview. Preview again.` };
    let changes;
    try { changes = computeChanges(descs, plan.runId); } catch (e) { return { ok: false, status: 409, error: `${(e as Error).message}. Preview again.` }; }
    for (const c of changes) {
      const p = plan.files.find((f) => f.file === c.file);
      if (!p || p.afterSha !== c.afterSha) return { ok: false, status: 409, error: `${c.file} would change differently than previewed. Preview again.` };
    }
    const promptOp = plan.ops.find((o) => o.op === "write-director-prompt");

    // 2. backup first. Nothing is changed if any copy fails.
    const runDir = join(adoptDir(root), plan.runId), backupRoot = join(runDir, "backup");
    mkdir700(adoptDir(root)); mkdir700(runDir); mkdir700(backupRoot);
    const files: ManifestFile[] = [];
    const fail = (status: 400 | 409 | 500, error: string, rolledBack = false): ApplyResult => ({ ok: false, status, error, rolledBack });
    try {
      for (const c of changes) {
        const backup = join(backupRoot, c.file);
        mkdir700(dirname(backup)); copyFileSync(c.file, backup); chmodSync(backup, 0o600);
        if (sha256File(backup) !== c.beforeSha) throw new Error(`backup of ${c.file} does not match the original`);
        files.push({ file: c.file, beforeSha: c.beforeSha, afterSha: c.afterSha, backup, mode: statSync(c.file).mode & 0o777, opIds: c.steps.map((s) => plan.ops[s.opIndex].id) });
      }
      if (promptOp && "file" in promptOp) {
        const pf = promptOp.file;
        if (existsSync(pf)) {
          const backup = join(backupRoot, pf);
          mkdir700(dirname(backup)); copyFileSync(pf, backup); chmodSync(backup, 0o600);
          files.push({ file: pf, beforeSha: sha256File(pf), afterSha: "", backup, mode: statSync(pf).mode & 0o777, opIds: [promptOp.id] });
        } else files.push({ file: pf, beforeSha: null, afterSha: "", backup: null, mode: 0o600, opIds: [promptOp.id] });
      }
    } catch (e) { rmSync(runDir, { recursive: true, force: true }); return fail(500, `Backup failed, nothing was changed: ${(e as Error).message}`); }

    // 3. manifest (shas and parked entries only; env and header values are blanked in parked entries)
    const parked = changes.flatMap((c) => c.steps.flatMap((s) => (s.parked ? [s.parked] : [])));
    const m: Manifest = {
      runId: plan.runId, createdAt: new Date(now()).toISOString(), workspace: plan.workspace, planId: plan.planId, state: "applying", files, created: [], parked,
      ops: plan.ops.map((o) => ({ id: o.id, op: o.op, ...("file" in o && o.file ? { file: o.file } : {}), findingId: o.findingId, fromActions: o.fromActions })),
    };
    saveManifest(root, m);

    // 4. apply; any failure puts everything back
    try {
      for (const c of changes) {
        write(c.file, c.afterText, files.find((f) => f.file === c.file)!.mode);
        if (c.file.endsWith(".json")) JSON.parse(readFileSync(c.file, "utf8"));
        if (sha256File(c.file) !== c.afterSha) throw new Error(`${c.file} does not match the plan after writing`);
      }
      const souls = descs.flatMap((d) => (d.op === "register-souls" ? [{ repo: d.repo, name: d.name, source: d.source, defFile: d.defFile }] : []));
      if (souls.length) {
        const r = registerSouls(souls, { runId: plan.runId, builtinRoles: opts.builtinRoles, dir: wsd });
        m.created = r.created;
        if (r.errors.length) throw new Error(r.errors.join("; "));
      }
      if (promptOp && "file" in promptOp) {
        const { writeDirectorPrompt } = await import("./director");
        const names = souls.map((s) => s.name);
        const pf = writeDirectorPrompt({ mode: "adopt", workspace: plan.workspace, repos: opts.repos ?? [...new Set(souls.map((s) => s.repo))], souls: names }, root);
        const e = files.find((f) => f.file === pf)!; e.afterSha = sha256File(pf);
      }
    } catch (e) {
      saveManifest(root, m);
      const back = restore(m, root, wsd, true);
      m.state = "failed"; m.error = (e as Error).message; m.kept = back.kept.map((k) => k.file); saveManifest(root, m);
      return fail(500, `Apply failed and was rolled back: ${(e as Error).message}`, back.kept.length === 0);
    }
    m.state = "applied"; saveManifest(root, m);
    prune(root, plan.runId);
    return { ok: true, runId: plan.runId, manifest: m, runDir };
  } finally { busy = false; }
}

/** Keep the newest KEEP_RUNS runs; never the one just made. Only after a run completed. */
function prune(root: string, current: string): void {
  const runs = listRuns(root);
  for (const r of runs.slice(KEEP_RUNS)) if (r.runId !== current && r.state !== "applying") rmSync(join(adoptDir(root), r.runId), { recursive: true, force: true });
}

export interface RunInfo { runId: string; createdAt: string; workspace: string; state: Manifest["state"]; files: number; created: number }
/** All runs, newest first. */
export function listRuns(root: string = ROOT): RunInfo[] {
  let names: string[] = []; try { names = readdirSync(adoptDir(root)); } catch { return []; }
  const out: RunInfo[] = [];
  for (const n of names) { const m = readManifest(root, n); if (m) out.push({ runId: m.runId, createdAt: m.createdAt, workspace: m.workspace, state: m.state, files: m.files.length, created: m.created.length }); }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.runId < b.runId ? 1 : -1));
}

/** Put one run's files back. A file edited after apply is kept unless force. Created files are deleted when unchanged. */
/** A file something else (Claude Code answering the director's MCP dialog) is about to write after Apply: back it up (or note it did not exist) into the run, so Rollback restores or removes it. Idempotent. Returns an error text, or null. */
export function noteLateFile(runId: string, file: string, root: string = ROOT): string | null {
  const m = readManifest(root, runId);
  if (!m || m.state !== "applied") return "no applied run to record this in";
  if (m.files.some((f) => f.file === file)) return null;
  try {
    const before = shaOrNull(file); let backup: string | null = null;
    if (before !== null) {
      backup = join(adoptDir(root), runId, "backup", file);
      mkdir700(dirname(backup)); copyFileSync(file, backup); chmodSync(backup, 0o600);
      if (sha256File(backup) !== before) return `backup of ${file} does not match the original`;
    }
    m.files.push({ file, beforeSha: before, afterSha: "", backup, mode: before !== null ? statSync(file).mode & 0o777 : 0o644, opIds: [] });
    saveManifest(root, m);
    return null;
  } catch (e) { return (e as Error).message; }
}

function restore(m: Manifest, root: string, wsd: string, force: boolean): { restored: string[]; removed: string[]; kept: RollbackResult["kept"] } {
  const restored: string[] = [], removed: string[] = [], kept: RollbackResult["kept"] = [];
  const only = m.state === "rolledback" && m.kept?.length ? new Set(m.kept) : null; // a forced second pass handles only what was kept
  for (const f of m.files) {
    if (only && !only.has(f.file)) continue;
    const cur = shaOrNull(f.file);
    if (cur === f.beforeSha) continue; // already original (or never written)
    const mine = cur === f.afterSha;
    // afterSha "" = the prompt file when the run failed before writing it: any current content other than the backup is ours
    const unknownAfter = f.afterSha === "";
    if (cur !== null && !mine && !unknownAfter && !force) { kept.push({ file: f.file, backup: f.backup, why: "edited after the run" }); continue; }
    if (f.backup) {
      if (!existsSync(f.backup)) { kept.push({ file: f.file, backup: f.backup, why: "backup file is missing" }); continue; }
      mkdirSync(dirname(f.file), { recursive: true });
      writeAtomic(f.file, readFileSync(f.backup), f.mode); restored.push(f.file);
    } else if (cur !== null) { rmSync(f.file); removed.push(f.file); }
  }
  if (!only) for (const p of removeSouls({ runId: m.runId, dir: wsd })) removed.push(p);
  return { restored, removed, kept };
}

export function rollbackRun(runIdIn?: string, o: { root?: string; workspaceDir?: string; force?: boolean } = {}): RollbackResult {
  const root = o.root ?? ROOT, wsd = o.workspaceDir ?? wsDir();
  const runs = listRuns(root);
  // default target: the newest applied run; with force also the newest rolled-back run that kept files
  const runId = runIdIn ?? runs.find((r) => r.state === "applied")?.runId ?? (o.force ? runs.find((r) => r.state === "rolledback" && readManifest(root, r.runId)?.kept?.length)?.runId : undefined) ?? null;
  if (!runId) return { ok: true, runId: null, nothingToDo: true, restored: [], removed: [], kept: [], notes: ["nothing to do: no applied run"] };
  const m = readManifest(root, runId);
  if (!m) return { ok: false, runId, restored: [], removed: [], kept: [], notes: [], error: `no such run: ${runId}` };
  if (m.state === "rolledback" && !(o.force && m.kept?.length)) return { ok: true, runId, nothingToDo: true, restored: [], removed: [], kept: [], notes: ["nothing to do: already rolled back"] };
  if (m.state === "applying") return { ok: false, runId, restored: [], removed: [], kept: [], notes: [], error: "that run is still applying" };
  const r = restore(m, root, wsd, !!o.force);
  m.state = "rolledback"; m.rolledBackAt = new Date().toISOString(); m.kept = r.kept.map((k) => k.file);
  saveManifest(root, m);
  const notes = r.kept.map((k) => `kept your newer version of ${k.file}; backup at ${k.backup}`);
  if (m.files.some((f) => f.file.endsWith("agentnet-director.md"))) notes.push("restart the director to load your original instructions");
  return { ok: true, runId, restored: r.restored, removed: r.removed, kept: r.kept, notes };
}
