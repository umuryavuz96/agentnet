import type { Hono } from "hono";
import type { Env } from "../core/http";
import { live } from "./store";

/** GET /agentnet/summary (under /api/v1): counts for a host badge. Open like the other panel reads. */
export function summaryRoute(api: Hono<Env>): void {
  api.get("/agentnet/summary", (c) => {
    const all = live();
    return c.json({ live: all.length, working: all.filter((s) => s.state === "working").length, blocked: all.filter((s) => s.state === "blocked").length });
  });
}
