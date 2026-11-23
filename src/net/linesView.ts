// Step 8b: read views of the lines for root and the panel (docs/internal/one-folder/SPEC-step8b-picks.md §6), and the panel routes
// job 8c's Lines view calls. Panel auth: a panel or root token, a login cookie or loopback sees everything; an agent token reads
// without root fields and gets 403 when it asks for them. Writes (/agentnet-panel/ prefix) are root-only through mount.ts isPanelWrite.
import type { Hono } from "hono";
import { problem, type Env } from "../core/http";
import { audit } from "../core/logger";
import { activateLine, allLines, allProofsOf, bodyOf, ewma, forkLine, linesOn, readLine, retireLine, rewardOf, versionsOf, type LineJson } from "./lines";
import { approveProposal, listProposals, proposalsOf, rejectProposal } from "./proposals";
import { bad, body } from "./routes";
import { scoreDb } from "./scores";

type JobRow = { gen: number; job_id: number; closed_at: number; grade: number; provisional: number; verified: number; done: number; rework: number };
const jobsOfLine = (line: string) => scoreDb().query("SELECT gen, job_id, closed_at, grade, provisional, verified, done, rework FROM job_scores WHERE agent = ? AND grade IS NOT NULL ORDER BY closed_at, id").all(line) as JobRow[];
const r2 = (x: number | null) => (x == null ? null : Math.round(x * 100) / 100);

export interface LineRow { line: string; role: string; status: LineJson["status"]; current: number; baseline: number | null; parent: string | null; jobs: number; lastReward: number | null; lastPick: number | null }
/** One row per line, by role then name. */
export function linesList(): LineRow[] {
  return allLines().map(({ line, json }) => {
    const jobs = jobsOfLine(line), last = jobs.at(-1);
    const pick = scoreDb().query("SELECT MAX(ts) AS ts FROM picks WHERE kind = 'line' AND chosen = ?").get(line) as { ts: number | null } | null;
    return { line, role: json.role, status: json.status, current: json.current, baseline: json.baseline, parent: json.parent, jobs: jobs.length, lastReward: last ? rewardOf(last) : null, lastPick: pick?.ts ?? null };
  }).sort((a, b) => a.role.localeCompare(b.role) || a.line.localeCompare(b.line, undefined, { numeric: true }));
}

export interface PickView { id: number; ts: number; chosen: string | null; prob: number | null; p: number | null; fallback: boolean; candidates: { line: string; n: number; mean: number | null; p?: number }[] }
/** The last `n` line picks of the line's role where this line was a candidate. */
function picksFor(line: string, role: string, n = 50): PickView[] {
  const rows = scoreDb().query("SELECT id, ts, chosen, prob, candidates_json FROM picks WHERE kind = 'line' AND role = ? ORDER BY id DESC LIMIT 500").all(role) as { id: number; ts: number; chosen: string | null; prob: number | null; candidates_json: string | null }[];
  const out: PickView[] = [];
  for (const r of rows) {
    let cands: PickView["candidates"] = []; try { cands = JSON.parse(r.candidates_json ?? "[]"); } catch { /* bad row */ }
    if (!Array.isArray(cands) || !cands.some((c) => c?.line === line)) continue;
    out.push({ id: r.id, ts: r.ts, chosen: r.chosen, prob: r.prob, p: cands.find((c) => c.line === line)?.p ?? null, fallback: r.prob == null, candidates: cands });
    if (out.length >= n) break;
  }
  return out;
}

/** A line's detail. `root`: every proof row (rejected claims with their reason); otherwise only verified proofs. */
export function lineDetail(line: string, root: boolean) {
  const json = readLine(line); if (!json) return null;
  const versions = versionsOf(line).map((v) => { const u = bodyOf(v); return { version: v.version, parentVersion: v.parent_version, gen: v.born_gen, status: v.status, text: u.text, scope: u.scope, check: u.check, reward: v.reward, adherence: v.adherence == null ? null : v.adherence === 1, baseline: v.baseline, lesson: v.lesson, created: v.created, settledAt: v.settled_at }; });
  const rewards: number[] = [];
  const baselineSeries = jobsOfLine(line).map((j) => { const r = rewardOf(j); rewards.push(r); return { gen: j.gen, job: j.job_id, at: j.closed_at, reward: r, baseline: r2(ewma(rewards)) }; });
  // root: every proof row as stored (rejected claims, their reason and tool_use_id); others: verified proofs only, no claim details
  const proofs = root ? allProofsOf(line) : allProofsOf(line).filter((p) => p.status === "verified").map((p) => ({ id: p.id, gen: p.gen, source: p.source, status: p.status, evidence: p.evidence, at: p.at }));
  // proposals are root fields (they carry what an agent asked for); the files list holds paths and sizes only
  return { name: line, line: json, versions, baselineSeries, proofs, picks: picksFor(line, json.role), ...(root ? { proposals: proposalsOf(line) } : {}) };
}

/** Panel routes: GET list and detail, proposals; POST approve/reject and retire/fork/activate (root-only by the /agentnet-panel/ prefix). */
export function linesPanelRoutes(api: Hono<Env>) {
  const isRootCred = (c: { get: (k: "auth") => Env["Variables"]["auth"] }) => c.get("auth") !== "agent";
  api.get("/agentnet-panel/lines", (c) => c.json({ on: linesOn(), lines: linesList() })); // on: AGENTNET_LINES, so the panel can say "lines are off"
  api.get("/agentnet-panel/lines/proposals", (c) => {
    if (!isRootCred(c)) return problem(c, 403, "Forbidden", "root only");
    const st = c.req.query("status"); return c.json({ proposals: listProposals(st === "pending" || st === "approved" || st === "rejected" ? st : undefined) });
  });
  api.get("/agentnet-panel/lines/:line", (c) => {
    const root = isRootCred(c);
    if (c.req.query("include") === "root" && !root) return problem(c, 403, "Forbidden", "root fields are root only");
    const d = lineDetail(c.req.param("line") ?? "", root); return d ? c.json({ ...d, root }) : problem(c, 404, "Not Found", "no such line");
  });
  api.post("/agentnet-panel/lines/proposals/:id/:op{approve|reject}", async (c) => {
    const id = c.req.param("id"), op = c.req.param("op") as "approve" | "reject", b = await body(c as never);
    try {
      const out = op === "approve" ? approveProposal(id, b) : rejectProposal(id, b);
      if ("error" in out) return out.status === 422 ? bad(c as never, out.error) : problem(c, out.status, out.status === 404 ? "Not Found" : "Conflict", out.error);
      audit(c.get("actor"), `agentnet.proposal.${op}`, id, "ok", c.get("trace"), { line: out.ok.line, kind: out.ok.kind, applied: out.ok.applied ?? "" });
      return c.json({ proposal: out.ok });
    } catch (e) { return problem(c, 409, "Conflict", `agentnet: ${(e as Error).message}`); }
  });
  api.post("/agentnet-panel/lines/:line/:op{retire|fork|activate}", async (c) => {
    const line = c.req.param("line"), op = c.req.param("op"), b = await body(c as never);
    if (!readLine(line)) return problem(c, 404, "Not Found", "no such line");
    try {
      const out = op === "retire" ? retireLine(line, `owner: ${typeof b.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, 200) : "retired from the panel"}`)
        : op === "fork" ? forkLine(line, typeof b.as === "string" && /^[a-z0-9][a-z0-9-]{1,39}$/.test(b.as) ? b.as : undefined) : { changed: activateLine(line) };
      audit(c.get("actor"), `agentnet.line.${op}`, line, "ok", c.get("trace"), {});
      return c.json({ ...out, line: readLine(line) });
    } catch (e) { return problem(c, 409, "Conflict", `agentnet: ${(e as Error).message}`); }
  });
}
