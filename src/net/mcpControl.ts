// Per-session MCP switch: the panel asks, the agent's plugin does it. A switch rides to the plugin on its long-poll (`mcp`
// in the /poll answer); the plugin takes the server's tools out of the session (tool.list), keeps that list in its session
// state, and posts the servers as they stand to POST /mcp. Nothing writes an MCP or settings file, and a switch ends with
// the session. In memory only: a server restart forgets it all, and the next ask reads it back from the plugin.
import { polledLately } from "./liveness";

export interface McpServer { name: string; status: string; on: boolean; tools?: number }
interface Report { at: number; servers: McpServer[] }
const STATUSES = new Set(["connected", "failed", "auth", "disabled", "unapproved", "policy", "unknown"]);
/** A GET this soon after the last report does not wake the plugin again: the panel asks every few seconds. */
export const MCP_FRESH = 5_000;
const capable = new Set<string>(); // agent names whose plugin said hello with caps "mcp"
const reports = new Map<string, Report>();
const sets = new Map<string, Map<string, boolean>>(); // switches not yet reported back: server -> on
const due = new Set<string>(); // agent names whose plugin has something to fetch
const taken = new Set<string>(); // agent|server: the plugin has the switch; the next report settles it
let waker: (name: string) => void = () => {};

export const setMcpWaker = (fn: (name: string) => void) => { const was = waker; waker = fn; return was; };
/** Hello. The plugin keeps its switches across a reload, so only the old report goes; a switch not fetched yet stays. */
export function setMcpCapable(name: string, on: boolean) {
  reports.delete(name);
  if (!on) { capable.delete(name); sets.delete(name); due.delete(name); return; }
  capable.add(name);
  if (sets.get(name)?.size) { due.add(name); waker(name); }
}
export const mcpReady = (name: string) => capable.has(name) && due.has(name);
/** What the /poll answer carries: the switches to apply. Any answer with `mcp` asks for a report. */
export function mcpTake(name: string): { set: { server: string; on: boolean }[] } | null {
  if (!mcpReady(name)) return null;
  due.delete(name);
  const set = [...(sets.get(name) ?? [])].map(([server, on]) => { taken.add(`${name}|${server}`); return { server, on }; });
  return { set };
}
export function mcpReported(name: string, raw: unknown, now = Date.now()) {
  const servers: McpServer[] = [];
  for (const s of (Array.isArray(raw) ? raw : []).slice(0, 100) as Record<string, unknown>[]) {
    if (typeof s?.name !== "string" || !s.name) continue;
    const tools = Number(s.tools);
    servers.push({ name: s.name.slice(0, 120), status: STATUSES.has(String(s.status)) ? String(s.status) : "unknown", on: s.on !== false, ...(tools > 0 ? { tools: Math.floor(tools) } : {}) });
  }
  reports.set(name, { at: now, servers });
  const want = sets.get(name);
  for (const [server, on] of want ?? []) if (taken.delete(`${name}|${server}`) || servers.some((s) => s.name === server && s.on === on)) want!.delete(server);
}
/** The panel's view; asking also tells the plugin to read the servers again. `capable` false: this agent's plugin cannot switch. */
export function mcpView(name: string, id: string, now = Date.now()) {
  const able = capable.has(name) && polledLately(id, now), r = reports.get(name), want = sets.get(name);
  if (able && (!r || now - r.at >= MCP_FRESH) && !due.has(name)) { due.add(name); waker(name); }
  return {
    capable: able, at: r?.at ?? null,
    servers: (r?.servers ?? []).map((s) => { const w = want?.get(s.name); return w === undefined ? { ...s, pending: false } : { ...s, on: w, pending: true }; }),
  };
}
/** False: the plugin cannot do it, or the report names no such server. */
export function mcpSwitch(name: string, id: string, server: string, on: boolean, now = Date.now()): boolean {
  if (!capable.has(name) || !polledLately(id, now) || !reports.get(name)?.servers.some((s) => s.name === server)) return false;
  const want = sets.get(name) ?? sets.set(name, new Map()).get(name)!;
  want.set(server, on); taken.delete(`${name}|${server}`); due.add(name); waker(name);
  return true;
}
/** Tests only. */
export function mcpReset() { capable.clear(); reports.clear(); sets.clear(); due.clear(); taken.clear(); }
