// agentnet traffic in the chat is work, not conversation: every message to or from the agent, every service notice, every
// plugin delivery and the agent's own mcp__agentnet__* calls become tool-call rows (tool "agentnet") inside the turn's trail,
// at the time they happened. Owner prompts and the agent's own words stay chat rows (chatFeed.ts buildRows).
// A row is one line ("Message from builder-x: status", "Sent to root: done", "Step 2 done") that opens to In and Out.
import type { Msg } from "./net";
import type { FeedItem, Filter, PlanBit } from "./chatFeed";

/** The name the agentnet service sends its notices as (src/net/finish.ts SERVICE). */
export const SERVICE = "agentnet";
const AN_CALL = /^agentnet · (\w+)/;
const first = (s: string, n = 80) => { const l = s.trim().split("\n")[0]!.trim(); return l.length > n ? l.slice(0, n - 1) + "…" : l; };

/** The input of an agentnet call, read back from the In text (the feed sends it as JSON, clipped when long). */
export function callInput(inp: string | undefined): Record<string, unknown> {
  if (!inp) return {};
  try { const j = JSON.parse(inp); if (j && typeof j === "object") return j as Record<string, unknown>; } catch { /* clipped */ }
  const out: Record<string, unknown> = {};
  for (const m of inp.matchAll(/"(\w+)":\s*"((?:[^"\\]|\\.)*)"/g)) if (!(m[1]! in out)) out[m[1]!] = m[2]!.replace(/\\n/g, "\n").replace(/\\(.)/g, "$1");
  return out;
}

/** Which agentnet tool a feed step ran, or null when it was another tool. */
export const agentnetCall = (it: FeedItem): string | null => (it.kind === "step" ? AN_CALL.exec(it.title ?? "")?.[1] ?? null : null);

const NAMES: Record<string, string> = {
  inbox: "Read the inbox", plan_set: "Set the plan", step_add: "Added a step", step_drop: "Dropped a step", trail_search: "Searched past work",
  self_upgrade: "Proposed an upgrade", upgrade_proof: "Proved the upgrade", ask_owner_check: "Asked the owner to check", team_tasks: "Team board",
  set_status: "Set the status", keep: "Kept a process", job_open: "Opened a job", propose_rule: "Proposed a rule", propose_skill: "Proposed a skill",
  task_add: "Added a task", task_start: "Started a task", task_done: "Finished a task",
};
/** The one-line label of the agent's own agentnet call. `stepNo` names the plan step a step_done closed. */
export function callLabel(tool: string, input: Record<string, unknown>, stepNo?: string | null): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const what = s("subject") || first(s("body"));
  switch (tool) {
    case "send": return s("to") ? `Sent to ${s("to")}${what ? `: ${what}` : ""}` : "Sent a message";
    case "team_send": return `Posted to ${s("team") || "the team"}${what ? `: ${what}` : ""}`;
    case "report": return `Reported ${s("state") || "progress"}`;
    case "step_done": return stepNo ? `Step ${stepNo} done` : "Step done";
  }
  return NAMES[tool] ?? `agentnet · ${tool.replace(/_/g, " ")}`;
}

/** The label of a message row, seen from `agent`'s side. */
export function msgLabel(m: Msg, agent: string): string {
  const what = m.subject || first(m.body);
  if (m.from === agent) return `Sent to ${m.to}${what ? `: ${what}` : ""}`;
  if (m.from === SERVICE) return `agentnet: ${what || m.kind}`;
  return `Message from ${m.from}${what ? `: ${what}` : ""}`;
}

/** The plan step a step_done call closed: the step whose close time is nearest after the call. */
function closedStep(ts: number, plan: PlanBit[]): string | null {
  let best: PlanBit | null = null;
  for (const p of plan) if (p.end != null && p.end >= ts - 2_000 && p.end <= ts + 60_000 && (!best || p.end < best.end!)) best = p;
  return best ? (best.job != null ? `${best.job}.${best.n}` : String(best.n)) : null;
}

const SEND_EARLY = 120_000, SEND_LATE = 5_000;
/** Messages and feed items as one list for buildRows, every agentnet item a tool row. `filter`: all = both, messages = the
 *  agentnet rows only, terminal = the feed only (its agentnet calls and deliveries still show as rows). */
export function agentnetFeed(msgs: Msg[], items: FeedItem[], filter: Filter, agent: string, plan: PlanBit[] = []): FeedItem[] {
  const out: FeedItem[] = [];
  const ids = new Set(filter === "terminal" ? [] : msgs.map((m) => m.id).filter((x): x is number => x != null));
  const sends: FeedItem[] = []; // the agent's own send calls, which a message it sent folds into
  for (const it of items) {
    const tool = agentnetCall(it);
    if (tool) {
      const input = callInput(it.inp);
      const row: FeedItem = { ...it, tool: "agentnet", title: callLabel(tool, input, tool === "step_done" ? closedStep(it.ts, plan) : null) };
      if (tool === "send") sends.push(row);
      out.push(row);
    } else if (it.kind === "delivery") {
      if (it.msg != null && ids.has(it.msg)) continue; // the message's own row says it
      out.push({ id: it.id, kind: "step", ts: it.ts, status: "ok", tool: "agentnet", title: `Message #${it.msg ?? "?"} delivered`, ...(it.msg != null ? { msg: it.msg } : {}) });
    } else if (filter !== "messages") out.push(it);
  }
  if (filter !== "terminal") {
    const used = new Set<FeedItem>();
    for (const m of msgs) {
      if (m.from === agent) { // the agent sent it: its send call already is the row
        const to = (c: FeedItem) => callInput(c.inp).to;
        const call = sends.find((c) => !used.has(c) && c.ts >= m.at - SEND_EARLY && c.ts <= m.at + SEND_LATE && (!to(c) || to(c) === m.to));
        if (call) { used.add(call); if (m.id != null) call.msg = m.id; continue; }
      }
      out.push({ id: `an:m:${m.id ?? `local:${m.at}`}`, kind: "step", ts: m.at, status: m.id == null ? "running" : "ok", tool: "agentnet", ...(m.id != null ? { msg: m.id } : {}), title: msgLabel(m, agent),
        inp: `${m.from} to ${m.to} · ${m.kind}${m.id != null ? ` · #${m.id}` : ""}${m.reply_to ? ` · answers #${m.reply_to}` : ""}${m.subject ? `\n${m.subject}` : ""}`, out: m.body });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
