// agentnet page contract: GET /agentnet/snapshot {seq, agents, messages} and the SSE
// /agentnet/stream: `hello` (full), `agent` (merge patch of one row), `gone` ({id, seq, prev, reason}), `msg`, `check` (an owner check created or resolved, whole row), `ping`.
// Every frame carries `id: <seq>` and `data.prev` (EventSource drops unknown fields). Phase 1 floor: `hello` on every
// reconnect, no ring buffer. Panel auth (requireAuth on the api app), not the agent token.
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../core/db";
import type { Env } from "../core/http";
import { doing, progressPct, ensureSchema, lastSeq, live, onPatch, type Patch, type Snapshot } from "./store";
import { onCheck, visibleChecks, type Check } from "./checks";
import { nameMap, onMessage, subjectOf } from "./routes";

const RECENT = 200;
export interface MsgRow { id: number; from: string; to: string; kind: string; subject: string; body: string; reply_to: number | null; at: number; state: string }
const names = () => nameMap();
type Raw = { id: number; from_agent: string; to_agent: string; kind: string; subject: string | null; body: string; reply_to: number | null; created_at: number; state: string };
const toRow = (m: Raw, n: Map<string, string>): MsgRow => ({ id: m.id, from: n.get(m.from_agent) ?? m.from_agent, to: n.get(m.to_agent) ?? m.to_agent, kind: m.kind === "message" ? "info" : m.kind, subject: m.subject ?? subjectOf(undefined, m.body), body: m.body.slice(0, 1600), reply_to: m.reply_to, at: m.created_at, state: m.state });
const COLS = "id, from_agent, to_agent, kind, subject, body, reply_to, created_at, state";
export function recentMessages(limit = RECENT): MsgRow[] {
  ensureSchema();
  const n = names();
  return (db().query(`SELECT ${COLS} FROM messages ORDER BY id DESC LIMIT ?`).all(limit) as Raw[]).reverse().map((m) => toRow(m, n));
}
/** One message row by id (the `msg` frame carries the whole row, so the page threads it without waiting for a hello). */
export function messageRow(id: number): MsgRow | null { const m = db().query(`SELECT ${COLS} FROM messages WHERE id = ?`).get(id) as Raw | null; return m ? toRow(m, names()) : null; }
export const row = (s: Snapshot) => ({ ...s, doing: doing(s), progressPct: progressPct(s) });
export const snapshot = () => ({ seq: lastSeq(), agents: Object.fromEntries(live().map((s) => [s.id, row(s)])), messages: recentMessages(), checks: visibleChecks() });

/** RFC 7386 merge patch between two rows: changed keys only, `null` for a removed key, arrays and objects whole. */
export function mergePatch(prev: Record<string, unknown> | null, next: Record<string, unknown>): Record<string, unknown> {
  if (!prev) return next;
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (!(k in next)) { out[k] = null; continue; }
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) out[k] = next[k] ?? null;
  }
  return out;
}

export function agentnetStreamRoutes(api: Hono<Env>) {
  ensureSchema();
  api.get("/agentnet/snapshot", (c) => c.json(snapshot()));
  api.get("/agentnet/stream", (c) => streamSSE(c, async (stream) => {
    const queue: Array<{ event: string; data: Record<string, unknown>; seq: number }> = [];
    let wake: (() => void) | null = null, prev = 0;
    const last = new Map<string, Record<string, unknown>>();
    const push = (ps: Patch[]) => {
      for (const p of ps) {
        const seq = p.snapshot.seq;
        if (p.removed) { last.delete(p.id); queue.push({ event: "gone", data: { id: p.id, reason: p.snapshot.goneReason }, seq }); continue; }
        const r = row(p.snapshot) as unknown as Record<string, unknown>;
        const patch = mergePatch(last.get(p.id) ?? null, r); last.set(p.id, r);
        if (Object.keys(patch).length) queue.push({ event: "agent", data: { id: p.id, patch }, seq });
      }
      wake?.();
    };
    // every stored message is a frame, whoever sent it (loopback root has no agent row); the row rides whole
    const pushMsg = (id: number) => { const row = messageRow(id); if (row) { queue.push({ event: "msg", data: row as unknown as Record<string, unknown>, seq: lastSeq() }); wake?.(); } };
    const pushCheck = (k: Check) => { queue.push({ event: "check", data: k as unknown as Record<string, unknown>, seq: lastSeq() }); wake?.(); };
    const off = onPatch(push), offMsg = onMessage(pushMsg), offCheck = onCheck(pushCheck);
    stream.onAbort(() => { off(); offMsg(); offCheck(); wake?.(); });
    const hello = snapshot(); prev = hello.seq;
    for (const [id, s] of Object.entries(hello.agents)) last.set(id, s as unknown as Record<string, unknown>);
    await stream.writeSSE({ id: String(hello.seq), event: "hello", data: JSON.stringify({ ...hello, prev: 0 }) });
    let beat = Date.now();
    while (!stream.aborted) {
      if (!queue.length) await new Promise<void>((r) => { wake = r; setTimeout(r, 15_000); });
      wake = null;
      while (queue.length) { const f = queue.shift()!; await stream.writeSSE({ id: String(f.seq), event: f.event, data: JSON.stringify({ ...f.data, seq: f.seq, prev }) }); prev = f.seq; }
      if (Date.now() - beat > 15_000) { await stream.writeSSE({ event: "ping", data: JSON.stringify({ at: Date.now(), prev }) }); beat = Date.now(); }
    }
    off(); offMsg(); offCheck();
  }));
}
