/** What waits for the owner: pending owner checks plus reports sent to root that this device has not marked read. Shared by the rail count and the Waiting page. */
import { computed, ref } from "vue";
import { net, pendingChecks } from "./net";
import type { Check, Msg } from "./net";

const KEY = "waiting-read";
export const readIds = ref<Set<number>>(new Set((() => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } })()));
export function markRead(id: number) { readIds.value = new Set([...readIds.value, id]); try { localStorage.setItem(KEY, JSON.stringify([...readIds.value].slice(-200))); } catch { /* per-device convenience only */ } }

export type Item = { key: string; kind: "check" | "report"; at: number; who: string; title: string; check?: Check; msg?: Msg };
export const waitingItems = computed<Item[]>(() => {
  const out: Item[] = pendingChecks.value.map((c) => ({ key: "c" + c.id, kind: "check", at: c.createdAt, who: c.agent, title: c.question, check: c }));
  const answered = new Set(net.messages.filter((m) => m.from === "root" && m.reply_to != null).map((m) => m.reply_to));
  // a closed agent's report was handled when root closed it: only reports from agents still running can wait
  const live = new Set(Object.values(net.agents).filter((a) => a.life !== "gone" && a.life !== "failed").map((a) => a.name));
  // a report waits while it is over 10 minutes old and root has not replied to it (designer rule, 2026-11-16)
  for (const m of net.messages) if (m.kind === "report" && m.to === "root" && m.id != null && live.has(m.from) && !readIds.value.has(m.id) && !answered.has(m.id) && net.now - m.at > 600_000) out.push({ key: "m" + m.id, kind: "report", at: m.at, who: m.from, title: m.subject || m.body.slice(0, 80), msg: m });
  return out.sort((a, b) => b.at - a.at);
});
