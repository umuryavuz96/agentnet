// `agentnet doctor` checks. Returns lines and prints nothing, so the update path can compare before and after.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DoctorLine { level: "ok" | "warn" | "FAIL"; check: string; hint: string }

export const formatDoctorLine = (l: DoctorLine): string =>
  l.level === "ok" ? `ok   ${l.check}${l.hint ? " " + l.hint : ""}` : `${l.level.padEnd(4)} ${l.check}: ${l.hint}`;

async function getJson(u: string, ms: number): Promise<any | null> {
  try { const r = await fetch(u, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
}

export async function doctorLines(ctx: { root: string; host: string; port: number }): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  const out = (level: DoctorLine["level"], check: string, hint = "") => lines.push({ level, check, hint });
  process.versions.bun ? out("ok", "bun", process.versions.bun) : out("FAIL", "bun", "run agentnet with bun");
  for (const [bin, hint] of [["tmux", "install tmux"], ["claude", "install Claude Code"], ["python3", "the scripts need python3"]] as const)
    Bun.which(bin) ? out("ok", bin) : out("FAIL", bin, hint);
  try {
    mkdirSync(ctx.root, { recursive: true });
    const t = join(ctx.root, ".doctor"); writeFileSync(t, "x"); rmSync(t);
    out("ok", "data folder", ctx.root);
  } catch (e) { out("FAIL", "data folder", `${ctx.root} not writable (${(e as Error).message})`); }
  const h = await getJson(`http://${ctx.host}:${ctx.port}/v1/health`, 2000);
  if (h?.name === "agentnet") out("ok", "service", h.version);
  else {
    try {
      const l = Bun.listen({ hostname: ctx.host, port: ctx.port, socket: { data() {} } });
      l.stop(true);
      out("warn", "service", "not running (agentnet serve, or agentnet install-service)");
    } catch { out("FAIL", "service", `port ${ctx.port} in use by another program`); }
  }
  return lines;
}
