// Spawn-time routing: picks model + effort when the caller gave none. One place: it runs scripts/pick-model.sh (the rubric lives
// there and in model-routing.json; no second copy), which logs each pick itself. Personas come from brains (brains.ts), not from here:
// the soul catalog picker (pick-soul.sh) is switched off.
import { join } from "node:path";
import { usageMode } from "./routing";

export interface RouteInput { name: string; /** the brain picked for this spawn: a routing role when the name is not one */ brainName?: string; job?: string; ask?: string; need?: string; scope?: number; novelty?: number; risk?: number; model?: string; effort?: string; soul?: string; noLog?: boolean }
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

/** Brains whose name is not a routing role in model-routing.json, mapped to the nearest one. */
const BRAIN_ROLE: Record<string, string> = { "ios-dev": "mobile-dev", motion: "designer", "game-designer": "designer", "reviewer-qa": "qa", writer: "doc", generalist: "researcher" };
const DEFAULT_ROLE = "researcher"; // the generalist brain's role: last resort, so a spawn is never left on the default model

/** Roles to try in order: the name, the name with trailing dash parts dropped (web-dev-brains-1 → web-dev → web; the name itself already covers web-dev-brains),
 *  the brain's role, then the default. pick-model.sh itself drops a trailing -N. */
export function roleCandidates(name: string, brain?: string): string[] {
  const out = [name];
  const parts = name.replace(/-\d+$/, "").split("-");
  for (let n = parts.length - 1; n >= 1; n--) out.push(parts.slice(0, n).join("-"));
  if (brain) out.push(BRAIN_ROLE[brain] ?? brain);
  out.push(DEFAULT_ROLE);
  return [...new Set(out)];
}

/** Defaults scope 2, novelty 2, risk 1. An explicit model/effort always wins (a soul is passed through untouched); the picker still runs so reserve mode can refuse. A name that is no role falls back along roleCandidates; a missing picker leaves the spawn unrouted (never an error). */
export async function routeSpawn(i: RouteInput): Promise<Routed> {
  const res: Routed = { model: i.model, effort: i.effort, soul: i.soul, audit: null, warnings: [] };
  const lines: string[] = [];
  // Usage comes from the service's own reading (the same one the Routing page shows), so the picker never depends on the service's env.
  const u = (() => { try { const m = usageMode(); return m.windows.length ? m.basePct : null; } catch { return null; } })();
  // The name is tried as the role first; an unknown one falls back to roleCandidates (pick-model.sh exits 1 "unknown role" before it logs).
  let m = { code: 1, out: "", err: "" };
  for (const role of roleCandidates(i.name, i.brainName)) {
    m = await pick(role);
    if (!(m.code === 1 && m.err.includes("unknown role"))) break;
  }
  async function pick(role: string) { return run("pick-model.sh", ["--role", role, "--scope", String(clamp(i.scope, 1, 5, 2)), "--novelty", String(clamp(i.novelty, 1, 3, 2)), "--risk", String(clamp(i.risk, 0, 3, 1)),
    "--ask", i.ask ?? "", "--job", i.job ?? "", ...(u === null ? [] : ["--usage", String(u)]), ...(i.noLog ? ["--no-log"] : []), ...(i.model && MODELS.includes(i.model) ? ["--explicit", i.model] : [])]); }
  if (m.code === 2) throw new RouteBlocked(`usage reserve: ${m.err.split("\n").find((l) => l.startsWith("BLOCKED")) ?? m.out}`);
  if (m.code === 0 && m.out.startsWith("mode=")) {
    lines.push(m.out);
    res.model ??= field(m.out, "model"); res.effort ??= field(m.out, "effort");
    res.warnings.push(...m.err.split("\n").filter(Boolean));
  } else if (m.err) res.warnings.push(`model not routed: ${m.err.split("\n")[0]}`);
  res.audit = lines.join("\n") || null;
  return res;
}
