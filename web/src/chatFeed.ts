// The Chat tab timeline: agentnet messages and the agent's terminal feed merged by time into display rows.
// Messages = the agentnet thread only; Terminal = the terminal feed only (owner prompts, agent text, tool calls); All = both.
import type { Msg } from "./net";

export interface FeedItem {
  id: string; ts: number; kind: "owner" | "assistant" | "step" | "delivery" | "event";
  text?: string; nonce?: string; sending?: boolean;
  title?: string; status?: "running" | "ok" | "error"; ms?: number; out?: string; msg?: number;
}
export type Filter = "all" | "messages" | "terminal";
export const FILTERS: { id: Filter; label: string }[] = [{ id: "all", label: "All" }, { id: "messages", label: "Messages" }, { id: "terminal", label: "Terminal" }];
export const GROUP_MIN = 3;

export type Row =
  | { key: string; at: number; type: "msg"; m: Msg }
  | { key: string; at: number; type: "owner"; text: string; sending: boolean; nonce?: string }
  | { key: string; at: number; type: "assistant"; text: string }
  | { key: string; at: number; type: "step"; step: FeedItem }
  | { key: string; at: number; type: "steps"; steps: FeedItem[]; failed: number; running: boolean }
  | { key: string; at: number; type: "note"; text: string };

/** Keep the newest copy of every id, then drop a "sending" bubble whose nonce the transcript already shows. */
export function feedItems(items: Map<string, FeedItem>, pending: FeedItem[]): FeedItem[] {
  const all = [...items.values()];
  const seen = new Set(all.filter((i) => i.nonce).map((i) => i.nonce));
  return [...all, ...pending.filter((p) => p.nonce && !seen.has(p.nonce))];
}

export function buildRows(msgs: Msg[], items: FeedItem[], filter: Filter): Row[] {
  const raw: { at: number; o: number; row: Row | FeedItem }[] = [];
  let o = 0;
  if (filter !== "terminal") for (const m of msgs) raw.push({ at: m.at, o: o++, row: { key: `m:${m.id ?? "x"}:${m.at}`, at: m.at, type: "msg", m } });
  if (filter !== "messages") for (const i of items) raw.push({ at: i.ts, o: o++, row: i });
  raw.sort((a, b) => a.at - b.at || a.o - b.o);
  const out: Row[] = [];
  let run: FeedItem[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length >= GROUP_MIN) out.push({ key: `g:${run[0]!.id}`, at: run[0]!.ts, type: "steps", steps: run, failed: run.filter((s) => s.status === "error").length, running: run.some((s) => s.status === "running") });
    else for (const s of run) out.push({ key: `s:${s.id}`, at: s.ts, type: "step", step: s });
    run = [];
  };
  for (const { row } of raw) {
    if ("type" in row) { flush(); out.push(row); continue; }
    const i = row;
    if (i.kind === "step") { run.push(i); continue; }
    flush();
    if (i.kind === "owner") out.push({ key: `o:${i.id}`, at: i.ts, type: "owner", text: i.text ?? "", sending: !!i.sending, nonce: i.nonce });
    else if (i.kind === "assistant") out.push({ key: `a:${i.id}`, at: i.ts, type: "assistant", text: i.text ?? "" });
    else if (i.kind === "delivery") out.push({ key: `d:${i.id}`, at: i.ts, type: "note", text: `message #${i.msg} delivered` });
    else out.push({ key: `e:${i.id}`, at: i.ts, type: "note", text: i.text ?? "" });
  }
  flush();
  return out;
}
