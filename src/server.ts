import { Hono } from "hono";
import { HOST, PORT, VERSION } from "./core/config";
import { problem, requireAuth, tracing, type Env } from "./core/http";
import { logEvent } from "./core/logger";
import { bindOk, rootOnly } from "./core/access";
import { healthRoute } from "./net/health";
import { isPanelWrite, toLegacy } from "./net/mount";
import { agentnetTeamPanelRoutes } from "./net/teamRoutes";
import { agentnetRoutes, agentnetPanelSendRoute, agentPath, trailsPanelRoute } from "./net/routes";
import { trailStatsRoute } from "./net/trailStats";
import { agentnetStreamRoutes } from "./net/stream";
import { agentnetUsageRoutes } from "./net/usage";
import { startLiveness } from "./net/liveness";
import { summaryRoute } from "./net/summary";
import { bgjobRoutes } from "./net/bgjobs";
import { arsenalRoutes } from "./net/arsenal";
import { routingRoutes } from "./net/routing";
import { compactRoutes } from "./net/compact";
import { hooksRoutes } from "./net/hooks";
import { webRoutes } from "./net/web";
import { agentnetWindowRoutes, startSessionReaper } from "./net/windows";
import { agentControlRoutes } from "./net/controls";

export function buildApp(): Hono<Env> {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => { c.header("Agentnet-Api", "1"); await next(); }); // set before next: Hono copies it onto json, body and SSE responses
  app.use("*", tracing);
  healthRoute(app);
  const api = new Hono<Env>();
  api.use("*", requireAuth(agentPath));
  api.use("*", (c, next) => (isPanelWrite(c.req.method, c.req.path) ? rootOnly(c, next) : next())); // panel writes: loopback or the root token
  // Page routes before agentnetRoutes, as in the original server.
  agentnetStreamRoutes(api); agentnetUsageRoutes(api); agentnetPanelSendRoute(api); agentnetTeamPanelRoutes(api);
  trailsPanelRoute(api); trailStatsRoute(api); agentnetWindowRoutes(api); agentControlRoutes(api);
  summaryRoute(api); bgjobRoutes(api); arsenalRoutes(api); routingRoutes(api); compactRoutes(api); hooksRoutes(api);
  agentnetRoutes(api);
  app.route("/api/v1", api);
  webRoutes(app);
  app.notFound((c) => problem(c, 404, "Not Found", "no such route"));
  return app;
}

/** The Bun fetch handler: rewrite /v1/* to the legacy path, then hand the request to Hono with the Bun server as env. */
export function makeFetch(app: Hono<Env>) {
  return (req: Request, server?: unknown) => {
    const u = new URL(req.url), legacy = toLegacy(u.pathname);
    const orig = req;
    if (legacy) { u.pathname = legacy; req = new Request(u, req); }
    // requestIP needs the original Request object, not the rewritten copy
    const s = server as { requestIP?: (r: Request) => unknown } | undefined;
    const env = s?.requestIP ? { requestIP: () => s.requestIP!(orig) } : server;
    return app.fetch(req, env);
  };
}

if (import.meta.main) {
  if (!bindOk(HOST)) { console.error(`agentnet: refusing to listen on ${HOST}. Use 127.0.0.1 or one LAN or tailnet address (AGENTNET_HOST).`); process.exit(2); }
  const app = buildApp();
  Bun.serve({ hostname: HOST, port: PORT, fetch: makeFetch(app), idleTimeout: 0 }); // idleTimeout 0: SSE and 25 s long-polls
  startLiveness(); startSessionReaper();
  logEvent("info", "agentnet listening", { host: HOST, port: PORT, version: VERSION });
  console.log(`agentnet ${VERSION} on http://${HOST}:${PORT}`);
}
