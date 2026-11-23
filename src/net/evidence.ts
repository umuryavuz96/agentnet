// Proof on a closed step: `kind: value` strings from step_done, checked where a check is cheap. `ok` records what the server could
// verify: a commit exists in the agent's project, a file or shot is on disk, a message id is one the agent sent or got, a check
// line says PASS and not FAIL. `none: <reason>` is accepted and shown as such.
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { db } from "../core/db";
import { EVIDENCE_KINDS, type Evidence, type EvidenceKind } from "./jobs";

export const EVIDENCE_HELP = 'evidence is a list of "kind: value": commit: <hash> | file: <path> | check: <the PASS line> | shot: <path> | msg: <message id> | none: <why there is no proof> | expected: <the failure this step meant to show>';
/** "commit: abc123" or {kind, value} to kind and value. Error text when a line has no known kind or no value. */
export function parseEvidence(x: unknown): { kind: EvidenceKind; value: string }[] | { error: string } {
  const list = Array.isArray(x) ? x : x == null || x === "" ? [] : [x], out: { kind: EvidenceKind; value: string }[] = [];
  for (const it of list.slice(0, 6)) {
    const o = it && typeof it === "object" ? it as { kind?: unknown; value?: unknown } : null, m = o ? null : /^\s*([a-z]+)\s*[:=]\s*([\s\S]+)$/i.exec(String(it));
    const kind = String(o ? o.kind : m?.[1] ?? "").toLowerCase() as EvidenceKind, value = String(o ? o.value ?? "" : m?.[2] ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!EVIDENCE_KINDS.includes(kind) || !value) return { error: `agentnet: "${String(o ? JSON.stringify(it) : it).slice(0, 80)}" is not evidence. ${EVIDENCE_HELP}.` };
    out.push({ kind, value });
  }
  return out;
}
export const gitHas = (project: string, hash: string): boolean => { try { return Bun.spawnSync(["git", "-C", project, "cat-file", "-e", `${hash}^{commit}`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0; } catch { return false; } };
const onDisk = (project: string | null, p: string): boolean | null => {
  const path = p.startsWith("~/") ? join(process.env.HOME ?? "", p.slice(2)) : p;
  if (!isAbsolute(path) && !project) return null;
  try { return existsSync(isAbsolute(path) ? path : join(project!, path)) && statSync(isAbsolute(path) ? path : join(project!, path)).size > 0; } catch { return false; }
};
/** Check each piece of evidence for an agent (its project folder and its own messages). */
export function verifyEvidence(list: { kind: EvidenceKind; value: string }[], who: { id: string; project: string | null }): Evidence[] {
  return list.map(({ kind, value }) => {
    let ok: boolean | null = null;
    if (kind === "commit") { // "<hash>", or "<hash> <absolute repo path>" for a commit outside the agent's project
      const h = /\b[0-9a-f]{7,40}\b/i.exec(value)?.[0], repo = value.split(/\s+/).find((w) => isAbsolute(w)) ?? who.project;
      ok = !h ? false : repo ? gitHas(repo, h) : null;
    }
    else if (kind === "file" || kind === "shot") ok = onDisk(who.project, value.split(/\s+/)[0]!);
    else if (kind === "check") ok = /\bPASS(ED)?\b|\b0 fail\b|Validation passed/i.test(value) && !/\bFAIL(ED|URE)?\b/.test(value) && !/\b[1-9]\d* fail/i.test(value);
    else if (kind === "msg") { const id = Number(/\d+/.exec(value)?.[0]); ok = Number.isInteger(id) && !!db().query("SELECT 1 FROM messages WHERE id = ? AND (from_agent = ? OR to_agent = ?)").get(id, who.id, who.id); }
    return { kind, value, ok };
  });
}
