// The status sentence on a map card: the freshest signal wins, an old one never sticks.
// Pure (row + clock in, text out), so the stream tick re-evaluates it and tests pin it down.
import type { AgentRow, Check } from "./net";

/** A tool call this young is "what it does now"; older, the in-progress task text is the better sentence. */
export const TOOL_FRESH_MS = 20_000;
/** A set_status text older than newer tool activity by more than this is dropped. */
export const REPORT_STALE_MS = 120_000;
/** Idle longer than this shows "Idle · last: …". */
export const IDLE_SHOW_MS = 60_000;

const base = (p: string | null | undefined) => (p ? p.replace(/[\s"']+$/, "").split("/").pop() ?? p : "");

/** Plain words for one tool call, or null when the call is bookkeeping that says nothing about the work (set_status). */
export function toolPhrase(tool: string, target: string | null): string | null {
  const t = tool.replace(/^mcp__/, "");
  switch (tool) {
    case "Edit": case "MultiEdit": case "NotebookEdit": return `Editing ${base(target) || "a file"}`;
    case "Write": return `Writing ${base(target) || "a file"}`;
    case "Read": return `Reading ${base(target) || "a file"}`;
    case "Grep": case "Glob": return "Searching the code";
    case "WebSearch": return "Searching the web";
    case "WebFetch": return "Reading a web page";
    case "Agent": case "Task": return "Running a subagent";
    case "Skill": return `Loading skill ${target ?? ""}`.trim();
    case "Monitor": return "Watching a background job";
    case "Bash": return bashPhrase(target ?? "");
  }
  if (t.startsWith("agentnet__")) {
    const n = t.slice(10);
    if (n === "set_status") return null;
    if (/^task_/.test(n)) return "Updating its tasks";
    if (n === "trail_search") return "Searching past work";
    if (n === "inbox") return "Reading messages";
    if (n === "send" || n === "team_send") return "Sending a message";
    if (n === "report") return "Reporting to its boss";
    if (n === "ask_owner_check") return "Asking the owner";
    return null;
  }
  const m = /^([A-Za-z0-9-]+?)__(.+)$/.exec(t);
  if (m) {
    const srv = m[1].replace(/^claude[-_]?(ai|in)?[-_]/i, "").replace(/[-_]+/g, " ") || m[1];
    return `${srv.charAt(0).toUpperCase()}${srv.slice(1)}: ${m[2].replace(/_/g, " ")}`;
  }
  return tool;
}

function bashPhrase(cmd: string): string {
  const c = cmd.trim();
  if (/\b(bun|npm|pnpm|yarn)\s+(run\s+)?test\b|\b(vitest|jest|pytest)\b/.test(c)) return "Running tests";
  if (/\b(vue-)?tsc\b|\btypecheck\b|\bweb:check\b/.test(c)) return "Type-checking";
  if (/\bweb:build\b|\bvite build\b|\b(bun|npm|pnpm|yarn)\s+(run\s+)?build\b/.test(c)) return "Building";
  if (/\bgit\s+commit\b/.test(c)) return "Committing";
  if (/\bgit\s+(status|diff|log|show)\b/.test(c)) return "Checking git";
  if (/\bgit\s+/.test(c)) return "Running git";
  if (/\b(curl|wget)\b/.test(c)) return "Calling a URL";
  if (/\b(rg|grep|find|ls|cat|sed|head|tail|wc)\b/.test(c)) return "Looking at files";
  if (/\bsleep\b/.test(c)) return "Waiting";
  const w = /^(?:\w+=\S+\s+)*([\w./-]+)/.exec(c)?.[1];
  return w ? `Running ${base(w)}` : "Running a command";
}

/** "7s", "3m", "2h" */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/** The timestamp of the freshest tool signal (a running call, else the last finished one). */
const toolAt = (r: AgentRow) => Math.max(r.action?.at ?? 0, r.lastTool?.at ?? 0);
const lastPhrase = (r: AgentRow) => {
  const x = r.action ?? r.lastTool; // a running call is newer than the last finished one
  return x ? toolPhrase(x.tool, x.target) : null;
};

/** The freshest honest sentence for this agent, or null when nothing is known (the caller shows a prompt line or the state label).
 *  Order: blocked > waiting on the owner / a reply > idle summary > a tool call under 20 s old > in-progress task > a set_status text not outrun by newer work. */
export function cardLine(r: AgentRow, now: number, checks: Check[] = []): string | null {
  if (r.reported?.blockedOn) return "Blocked: " + r.reported.blockedOn;
  const ask = checks.find((k) => k.state === "pending" && k.agent === r.name);
  if (ask) return "Waiting for the owner: " + ask.question;
  const tAt = toolAt(r), last = lastPhrase(r);
  const m = r.lastMsg;
  if (m && m.dir === "out" && (m.kind === "question" || m.kind === "task") && m.at > tAt && r.state !== "working") return `Waiting for ${m.peer} to reply`;
  const task = r.tasks?.find((k) => k.status === "in_progress")?.text;
  if (r.state === "idle" && now - r.stateSince > IDLE_SHOW_MS) {
    const what = last ?? task;
    return what ? `Idle · last: ${what} ${ago(now - (tAt || r.stateSince))} ago` : null;
  }
  if (tAt && now - tAt < TOOL_FRESH_MS && last) return last;
  if (task) return task;
  const rep = r.reported;
  if (rep?.doing && !(rep as { expired?: boolean }).expired &&!(tAt && tAt - rep.at > REPORT_STALE_MS)) return rep.doing;
  return last && tAt && now - tAt < IDLE_SHOW_MS ? last : null;
}
