import type { Hono } from "hono";
import { VERSION } from "../core/config";
import type { Env } from "../core/http";
import { cassReady } from "./trailSearch";

export const API_LEVEL = 1;
export interface Health { name: "agentnet"; version: string; api: 1; minClientApi: 1; features: string[] }

export function health(): Health {
  const features = ["teams", "trails", "scores", "usage"];
  if (Bun.which("tmux")) features.push("windows");
  if (cassReady()) features.push("cass");
  return { name: "agentnet", version: VERSION, api: API_LEVEL, minClientApi: 1, features };
}
/** GET /v1/health: no auth. */
export function healthRoute(app: Hono<Env>) { app.get("/v1/health", (c) => c.json(health())); }
