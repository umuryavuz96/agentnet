// Spawn-time routing: picks model + effort and the persona when the caller gave none. One place: it runs scripts/pick-model.sh and
// scripts/pick-soul.sh (the rubric lives there and in model-routing.json; no second copy). Those scripts log each pick themselves.
import { join } from "node:path";
import { usageMode } from "./routing";

export interface RouteInput { name: string; job?: string; ask?: string; need?: string; scope?: number; novelty?: number; risk?: number; model?: string; effort?: string; soul?: string; noLog?: boolean }
export interface Routed { model?: string; effort?: string; soul?: string; audit: string | null; warnings: string[] }
/** Reserve mode: the spawn is refused. `message` is the picker's own explanation. */
export class RouteBlocked extends Error {}

const SCRIPTS = () => process.env.AGENTNET_SCRIPTS_DIR ?? join(import.meta.dir, "..", "..", "scripts");
const MODELS = ["haiku", "sonnet", "opus", "fable"];
const field = (line: string, k: string) => new RegExp(`(?:^|\\s)${k}=(\\S+)`).exec(line)?.[1];
const clamp = (n: unknown, lo: number, hi: number, dflt: number) => (typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi ? n : dflt);

async function run(script: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["bash", join(SCRIPTS(), script), ...args], { stdout: "pipe", stderr: "pipe", env: process.env });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim().split("\n").pop() ?? "", err: err.trim() };
}

/** Defaults scope 2, novelty 2, risk 1. An explicit model/soul/effort always wins; the picker still runs so reserve mode can refuse. An unknown role or a missing catalog leaves the spawn unrouted (never an error). */
export async function routeSpawn(i: RouteInput): Promise<Routed> {
  const res: Routed = { model: i.model, effort: i.effort, soul: i.soul, audit: null, warnings: [] };
  const lines: string[] = [];
  // Usage comes from the service's own reading (the same one the Routing page shows), so the picker never depends on the service's env.
  const u = (() => { try { const m = usageMode(); return m.windows.length ? m.basePct : null; } catch { return null; } })();
  const m = await run("pick-model.sh", ["--role", i.name, "--scope", String(clamp(i.scope, 1, 5, 2)), "--novelty", String(clamp(i.novelty, 1, 3, 2)), "--risk", String(clamp(i.risk, 0, 3, 1)),
    "--ask", i.ask ?? "", "--job", i.job ?? "", ...(u === null ? [] : ["--usage", String(u)]), ...(i.noLog ? ["--no-log"] : []), ...(i.model && MODELS.includes(i.model) ? ["--explicit", i.model] : [])]);
  if (m.code === 2) throw new RouteBlocked(`usage reserve: ${m.err.split("\n").find((l) => l.startsWith("BLOCKED")) ?? m.out}`);
  if (m.code === 0 && m.out.startsWith("mode=")) {
    lines.push(m.out);
    res.model ??= field(m.out, "model"); res.effort ??= field(m.out, "effort");
    res.warnings.push(...m.err.split("\n").filter(Boolean));
  } else if (m.err) res.warnings.push(`model not routed: ${m.err.split("\n")[0]}`);
  if (!i.soul) {
    const role = i.name.replace(/-\d+$/, "");
    const s = await run("pick-soul.sh", ["--role", role, "--ask", i.ask ?? "", "--need", i.need || i.job || "", "--agent", i.name, "--job", i.job ?? "", ...(i.noLog ? ["--no-log"] : [])]);
    if (s.code === 0 && s.out.startsWith("soul=")) { lines.push(s.out); res.soul = field(s.out, "soul"); }
  }
  res.audit = lines.join("\n") || null;
  return res;
}
