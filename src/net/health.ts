import type { Hono } from "hono";
import { HOME, ROOT, VERSION } from "../core/config";
import type { Env } from "../core/http";
import { cassReady } from "./trailSearch";
import { logEvent } from "../core/logger";
import { deprecations, houseFlags, loopbackRootHits } from "../core/auth";

export const API_LEVEL = 1;
export interface Health { name: "agentnet"; version: string; api: 1; minClientApi: 1; features: string[]; home: string; houseFlags: string[]; deprecations: string[]; loopbackRootHits: number }

/** The data folder for display: starts with ~ when it is under the home folder, else the absolute path. */
export function shortHome(root: string, home: string): string {
  if (root === home) return "~";
  return root.startsWith(home + "/") ? "~" + root.slice(home.length) : root;
}

export function health(): Health {
  const features = ["teams", "trails", "scores", "usage"];
  if (Bun.which("tmux")) features.push("windows");
  if (cassReady()) features.push("cass");
  return { name: "agentnet", version: VERSION, api: API_LEVEL, minClientApi: 1, features, home: shortHome(ROOT, HOME), houseFlags: houseFlags(), deprecations: deprecations(), loopbackRootHits: loopbackRootHits() };
}
/** Boot: one warning line per deprecated setting in use (log file and stderr). Returns the lines. */
export function logDeprecations(warn: (line: string) => void = (l) => console.warn(l)): string[] {
  const out = deprecations();
  for (const d of out) { logEvent("warn", d); warn(`agentnet: ${d}`); }
  return out;
}
/** GET /v1/health: no auth. */
export function healthRoute(app: Hono<Env>) { app.get("/v1/health", (c) => c.json(health())); }
