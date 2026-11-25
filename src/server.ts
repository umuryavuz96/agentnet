import { Hono } from "hono";
import { HOST, PORT, ROOT, VERSION } from "./core/config";
import { recordLaunch } from "./update/launch";
import { problem, requireAuth, tracing, type Env } from "./core/http";
import { logEvent } from "./core/logger";
import { bindOk, rootOnly } from "./core/access";
import { ensureSecrets, houseFlags, newLoginCode, sessionCount } from "./core/auth";
import { ownerPaths } from "./core/paths";
import { startReviewTimer } from "./net/finish";
import { startOwnerTimer } from "./net/ownerAsks";
import { wireOwnerLearning } from "./net/ownerLearn";
import { registerLineHandlers } from "./net/lines";
import { accountRoutes } from "./net/accounts";
import { pairOpenRoutes, pairPanelRoutes } from "./net/pair";
import { loginApiRoutes, loginPageRoute } from "./net/login";
import { healthRoute, logDeprecations } from "./net/health";
import { isPanelWrite, toLegacy } from "./net/mount";
import { agentnetTeamPanelRoutes } from "./net/teamRoutes";
import { agentnetRoutes, agentnetPanelSendRoute, agentPath, trailsPanelRoute, isRoot } from "./net/routes";
import { closeStaleTeams } from "./net/teams";
import { trailStatsRoute } from "./net/trailStats";
import { agentnetStreamRoutes } from "./net/stream";
import { agentnetUsageRoutes } from "./net/usage";
import { startLiveness } from "./net/liveness";
import { summaryRoute } from "./net/summary";
import { bgjobRoutes } from "./net/bgjobs";
import { arsenalRoutes } from "./net/arsenal";
import { brainsRoutes } from "./net/brainsPanel";
import { evalsRoutes } from "./net/evals";
import { routingRoutes } from "./net/routing";
import { compactRoutes } from "./net/compact";
import { hooksRoutes } from "./net/hooks";
import { webRoutes } from "./net/web";
import { ownerChatRoutes } from "./net/ownerChat";
import { chatImageRoutes } from "./net/chatImages";
import { chatFileRoutes } from "./net/chatFiles";
import { agentnetWindowRoutes, healRootSession, startSessionReaper } from "./net/windows";
import { agentControlRoutes } from "./net/controls";
import { startUpdateTimers, updateRoutes } from "./net/update";
import { checksPanelRoutes } from "./net/checksPanel";
import { asksPanelRoutes } from "./net/asksPanel";
import { linesPanelRoutes } from "./net/linesView";
import { directorRoutes } from "./net/director";
import { adoptRoutes } from "./net/adopt";
import { importRoutes, restartStanding } from "./net/agent-import";
import { snapshotDiscipline } from "./net/scores";
import { metricsRoute } from "./net/metrics";
import { bootSweep } from "./net/sweep";

export function buildApp(): Hono<Env> {
  ensureSecrets(); // run/ 0700, root.token + panel.token 0600
  const app = new Hono<Env>();
  app.use("*", async (c, next) => { c.header("Agentnet-Api", "1"); await next(); }); // set before next: Hono copies it onto json, body and SSE responses
  app.use("*", tracing);
  healthRoute(app); pairOpenRoutes(app); // open: the pairing app has no credential yet
  const api = new Hono<Env>();
  api.use("*", requireAuth(agentPath));
  api.use("*", (c, next) => (isPanelWrite(c.req.method, c.req.path) ? rootOnly(c, next) : next())); // panel writes: loopback or the root token
  // Page routes before agentnetRoutes, as in the original server.
  agentnetStreamRoutes(api); agentnetUsageRoutes(api); agentnetPanelSendRoute(api); agentnetTeamPanelRoutes(api);
  trailsPanelRoute(api); trailStatsRoute(api); agentnetWindowRoutes(api); ownerChatRoutes(api); chatImageRoutes(api); chatFileRoutes(api); agentControlRoutes(api); checksPanelRoutes(api); asksPanelRoutes(api); linesPanelRoutes(api); metricsRoute(api);
  summaryRoute(api); bgjobRoutes(api); arsenalRoutes(api); brainsRoutes(api); evalsRoutes(api); routingRoutes(api); compactRoutes(api); hooksRoutes(api); updateRoutes(api); directorRoutes(api); adoptRoutes(api); importRoutes(api);
  loginApiRoutes(api); accountRoutes(api); pairPanelRoutes(api);
  agentnetRoutes(api);
  app.route("/api/v1", api);
  loginPageRoute(app);
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
  try { recordLaunch(ROOT, { version: VERSION }); } catch (e) { logEvent("warn", "server-launch.json not written", { error: String(e) }); }
  try { const n = closeStaleTeams((x) => isRoot({ name: x })).length; if (n) logEvent("info", "boot: stale team members moved to past", { teams: n }); } catch (e) { logEvent("warn", "stale team sweep failed", { error: String(e) }); } // data from before members left on despawn
  try { bootSweep(); } catch (e) { logEvent("warn", "boot sweep failed", { error: String(e) }); } // retired agents' leftover sessions
  restartStanding().catch((e) => logEvent("warn", "standing restart failed", { error: String(e) })); // before liveness marks them gone
  startLiveness(); startSessionReaper(); startReviewTimer(); wireOwnerLearning(); startOwnerTimer(); void registerLineHandlers(); try { healRootSession(); } catch { /* no tmux */ } startUpdateTimers();
  // Daily discipline snapshot (docs/task-discipline.md A3): now, then hourly; the line of today is replaced, earlier days are filled once.
  const snap = () => { try { snapshotDiscipline(); } catch (e) { logEvent("warn", "discipline snapshot failed", { error: String(e) }); } };
  setTimeout(snap, 15_000); setInterval(snap, 3600_000);
  logEvent("info", "agentnet listening", { host: HOST, port: PORT, version: VERSION });
  console.log(`agentnet ${VERSION} on http://${HOST}:${PORT}`);
  const owned = ownerPaths(); // writes outside the home happen only where the owner pointed an env var
  if (owned.length) { const list = owned.map((o) => `${o.env}=${o.path}`).join(", "); logEvent("info", "owner-chosen paths outside the home", { paths: list }); console.log(`agentnet: owner-chosen paths outside its folder: ${list}`); }
  for (const f of houseFlags()) { logEvent("warn", `house flag ${f}: loopback trust is on`, { flag: f }); console.warn(`agentnet: house flag ${f} is on`); }
  logDeprecations();
  if (sessionCount() === 0) { // first start: a fresh login link (one use, 60 s); later links come from `agentnet login`
    const link = `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}/login?code=${newLoginCode()}`;
    logEvent("info", "login link (one use, 60 s)", { url: link });
    console.log(`agentnet: sign in at ${link}`);
  }
}
