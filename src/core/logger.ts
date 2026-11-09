// Structured logging: one JSON object per line, OpenTelemetry field names,
// written to logs/agentnet.jsonl (rotated by size) and audit actions to logs/audit.jsonl (never rotated away).
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { dir } from "./config";

export type Level = "debug" | "info" | "warn" | "error";
const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = (): Level => { const l = process.env.AGENTNET_LOG_LEVEL; return l && l in RANK ? (l as Level) : "info"; };

export interface Trace { trace_id: string; span_id: string }

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
export const newTrace = (): Trace => ({ trace_id: hex(16), span_id: hex(8) });

/** W3C traceparent: "00-<32 hex trace>-<16 hex parent span>-<flags>". Keeps the caller's trace id, new span. */
export function fromTraceparent(h: string | undefined): Trace {
  const m = h?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/);
  return m && !/^0+$/.test(m[1]) ? { trace_id: m[1], span_id: hex(8) } : newTrace();
}
export const traceparent = (t: Trace) => `00-${t.trace_id}-${t.span_id}-01`;

function write(file: string, line: string, rotateAt?: number) {
  try {
    const d = dir("logs");
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    const p = join(d, file);
    if (rotateAt && existsSync(p) && statSync(p).size > rotateAt) renameSync(p, `${p}.1`);
    appendFileSync(p, line + "\n");
  } catch { /* logging must never take the server down */ }
}

export function logEvent(level: Level, message: string, attrs: Record<string, unknown> = {}, trace?: Trace) {
  if (RANK[level] < RANK[minLevel()]) return;
  const rec = { time: new Date().toISOString(), level, service: "agentnet", message, ...trace, attributes: attrs };
  write("agentnet.jsonl", JSON.stringify(rec), 20 * 1024 * 1024);
  if (level === "error") console.error(message, attrs);
}

/** Who did what. Kept separately from the rotated log. */
export function audit(actor: string, action: string, target: string, result: "ok" | "failed", trace?: Trace, attrs: Record<string, unknown> = {}) {
  const rec = { time: new Date().toISOString(), actor, action, target, result, ...trace, attributes: attrs };
  write("audit.jsonl", JSON.stringify(rec));
  logEvent("info", `${action} ${target}`, { actor, result, ...attrs }, trace);
}
