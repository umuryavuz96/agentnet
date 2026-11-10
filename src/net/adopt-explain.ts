// Plain-words explanation of a stored report, built by the server from the validated actions and facts (never from model text).
// view() adds it to the report: finding.change {before, after} and report.after (the planned structure). The stored report is not changed.
import { basename } from "node:path";
import type { Action, AdoptReport, Finding } from "./adopt-report";
import type { Facts } from "./adopt-scan";

export interface Change { before: string; after: string }
export interface AfterItem { kind: "hook" | "mcp" | "instructions" | "rules"; label: string; file: string }
export interface AfterOff extends AfterItem { findingId: string; actionId: string; /** off unless the owner opts in (instruction lines) */ optional: boolean }
export interface After {
  director: { name: "root" };
  agents: { name: string; soul: string; role: string | null; source: "agent-def" | "claude-md"; repo: string }[];
  stay: AfterItem[]; off: AfterOff[]; messaging: "agentnet";
}
const home = (p: string) => p.replace(/^\/Users\/[^/]+\//, "~/");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const scriptOf = (s: string) => basename(s.split(/\s+/).filter(Boolean).pop() ?? s);

const groups = (as: Action[]) => { const m = new Map<Action["op"], Action[]>(); for (const a of as) m.set(a.op, [...(m.get(a.op) ?? []), a]); return m; };

/** What changes for one finding, before and after. Sentences per kind of action, joined. */
export function changeOf(f: Finding): Change {
  const before: string[] = [], after: string[] = [];
  for (const [op, as] of groups(f.actions)) {
    const n = as.length;
    if (op === "park-hook") {
      before.push(`${plural(n, "hook")} (${as.map((a) => scriptOf((a as { commandIncludes: string }).commandIncludes)).slice(0, 3).join(", ")}) run${n === 1 ? "s" : ""} on Claude Code events and can move messages.`);
      after.push(`Parked: ${n === 1 ? "it stays" : "they stay"} in the file as a note but no longer run${n === 1 ? "s" : ""}. agentnet messages are the only channel.`);
    } else if (op === "park-mcp") {
      before.push(`MCP server ${as.map((a) => (a as { server: string }).server).join(", ")} is loaded into every agent here.`);
      after.push("Parked: not loaded any more. The entry is kept in the backup, so undo brings it back.");
    } else if (op === "disable-lines") {
      before.push(`${plural(n, "block")} of instructions (${as.map((a) => { const x = a as { file: string; fromLine: number; toLine: number }; return `${basename(x.file)} ${x.fromLine === x.toLine ? "line " + x.fromLine : "lines " + x.fromLine + "-" + x.toLine}`; }).slice(0, 3).join(", ")}) ${f.kind === "identity-claim" ? "say who the main agent is" : "tell agents how to message each other"}.`);
      after.push("Commented out. The rest of the file still loads. Off by default: you choose each one.");
    } else if (op === "register-souls") {
      before.push(`${plural(n, "repo agent")} (${as.map((a) => (a as { name: string }).name).join(", ")}) only exist${n === 1 ? "s" : ""} inside their own repos.`);
      after.push(`Added to the workspace as souls, so the director can start ${n === 1 ? "it" : "them"} as ${n === 1 ? "an agent" : "agents"}. The repo files are not touched.`);
    } else if (op === "manual") {
      before.push(as.map((a) => (a as { title: string }).title).join(" "));
      after.push("Left to you. agentnet changes nothing here.");
    }
  }
  if (!before.length) return { before: f.about, after: "Left as it is." };
  return { before: before.join(" "), after: after.join(" ") };
}

const sameHook = (a: { file: string; event: string; commandIncludes: string }, s: Record<string, unknown>) => s.id === "S-HOOK-INJECT" && s.file === a.file && s.event === a.event && typeof s.command === "string" && s.command.includes(a.commandIncludes);

export function afterOf(r: AdoptReport, facts: Facts | null): After {
  const acts = r.findings.flatMap((f) => f.actions.map((a) => ({ a, f })));
  const off: AfterOff[] = [];
  for (const { a, f } of acts) {
    if (a.op === "park-hook") off.push({ kind: "hook", label: `${a.event} hook ${scriptOf(a.commandIncludes)}`, file: home(a.file), findingId: f.id, actionId: a.id, optional: false });
    else if (a.op === "park-mcp") off.push({ kind: "mcp", label: `MCP server ${a.server}`, file: home(a.file), findingId: f.id, actionId: a.id, optional: false });
    else if (a.op === "disable-lines") off.push({ kind: "instructions", label: `${basename(a.file)} lines ${a.fromLine}-${a.toLine}`, file: home(a.file), findingId: f.id, actionId: a.id, optional: true });
  }
  const agents = acts.flatMap(({ a }) => (a.op === "register-souls" ? [{ name: a.name, soul: `ws/${a.name}`, role: a.roleClash ? null : a.name, source: a.source, repo: a.repo }] : []));
  const stay: AfterItem[] = [];
  const acted = acts.map((x) => x.a);
  for (const s of facts?.signals ?? []) {
    if (s.id === "S-HOOK-INJECT" && !acted.some((a) => a.op === "park-hook" && sameHook(a, s))) stay.push({ kind: "hook", label: `${String(s.event)} hook ${scriptOf(String(s.command ?? ""))}`, file: home(String(s.file ?? "")) });
    if (s.id === "S-MCP" && !acted.some((a) => a.op === "park-mcp" && a.file === s.file && a.server === s.server)) stay.push({ kind: "mcp", label: `MCP server ${String(s.server)}`, file: home(String(s.file ?? "")) });
  }
  if (facts) {
    stay.push({ kind: "instructions", label: "CLAUDE.md of the workspace still loads", file: home(`${facts.workspace}/CLAUDE.md`) });
    for (const p of facts.repos) if (p.hasClaudeMd) stay.push({ kind: "instructions", label: `${basename(p.path)}/CLAUDE.md still loads for that repo`, file: home(`${p.path}/CLAUDE.md`) });
  }
  return { director: { name: "root" }, agents, stay, off, messaging: "agentnet" };
}

/** The report as the page gets it: each finding with change, plus after. null stays null. */
export function explainReport<T extends AdoptReport>(r: T | null, facts: Facts | null): (T & { findings: (Finding & { change: Change })[]; after: After }) | null {
  if (!r) return null;
  return { ...r, findings: r.findings.map((f) => ({ ...f, change: changeOf(f) })), after: afterOf(r, facts) };
}
