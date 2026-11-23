// The owner's Asks page (docs/internal/SPEC-asks-ledger.md (d)): goals with their items and proof, and the owner's taps
// (an item is wrong or not wanted, something is missing, a heart). Panel auth; POSTs are root-only writes (mount.ts isPanelWrite).
import type { Context, Hono } from "hono";
import { audit } from "../core/logger";
import { problem, type Env } from "../core/http";
import { body, bad } from "./routes";
import { goalsView, ownerAsksOn, usageByDay, ownerHeart, ownerMark, ownerMissing } from "./ownerAsks";

const WEEK = 7 * 86_400_000;
type Out = { error: string; status: number } | object;
const fail = (c: Context<Env>, o: { error: string; status: number }) =>
  o.status === 422 ? bad(c as never, o.error) : problem(c, o.status, o.status === 404 ? "Not Found" : "Conflict", o.error);

export function asksPanelRoutes(api: Hono<Env>) {
  api.get("/agentnet-panel/goals", (c) => c.json({ on: ownerAsksOn(), goals: ownerAsksOn() ? goalsView(Date.now() - WEEK) : [] }));
  api.get("/agentnet-panel/goals/usage", (c) => c.json(usageByDay()));
  api.post("/agentnet-panel/goals/:id/:op{missing|heart}", async (c) => {
    const id = Number(c.req.param("id")), op = c.req.param("op"), b = await body(c as never);
    const out: Out = op === "missing" ? ownerMissing(id, String(b.text ?? "")) : ownerHeart(id);
    if ("error" in out) return fail(c as never, out as { error: string; status: number });
    audit(c.get("actor"), `agentnet.goal-${op}`, `G${id}`, "ok", c.get("trace"));
    return c.json({ ok: true });
  });
  api.post("/agentnet-panel/items/:id/mark", async (c) => {
    const id = Number(c.req.param("id")), b = await body(c as never), out: Out = ownerMark(id, String(b.mark ?? ""));
    if ("error" in out) return fail(c as never, out as { error: string; status: number });
    audit(c.get("actor"), "agentnet.item-mark", `item ${id}`, "ok", c.get("trace"), { mark: b.mark });
    return c.json({ ok: true });
  });
}
