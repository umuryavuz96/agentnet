// /v1/* paths are a URL rewrite in front of the existing handlers: one store, one waiters map, one auth rule.
const A = "/api/v1/agentnet/";
const TEAM = "teams(?:/[a-z0-9-]+(?:/(?:archive|members|messages|tasks(?:/\\d+/(?:start|done|claim))?))?)?";
const RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^\/v1\/agent\/(hello|bye|poll|ack|send|inbox|report|status|events|checks|gate|trail\/search)$/, (m) => A + m[1]],
  [/^\/v1\/agent\/(tasks(?:\/\d+\/(?:start|done))?)$/, (m) => A + m[1]],
  [/^\/v1\/agent\/(agents(?:\/[a-z0-9-]+)?)$/, (m) => A + m[1]],
  [new RegExp(`^/v1/agent/(${TEAM})$`), (m) => A + m[1]],
  [/^\/v1\/admin\/(spawn|plan-spawn|despawn|trail\/inject|adopt\/(?:facts|report|apply))$/, (m) => A + m[1]],
  [/^\/v1\/admin\/(agents\/[a-z0-9-]+\/(?:placement|grade))$/, (m) => A + m[1]],
  [/^\/v1\/panel\/(snapshot|stream|usage|scores|discipline|windows\/close-all)$/, (m) => A + m[1]],
  [/^\/v1\/panel\/(agents\/[a-z0-9-]+\/(?:score|tasks|message|open|close|schedules|stop|despawn|run-schedule|prompt|feed))$/, (m) => A + m[1]],
  [/^\/v1\/panel\/teams((?:\/[a-z0-9-]+(?:\/(?:archive|members|messages|tasks(?:\/\d+\/(?:start|done|claim))?))?)?)$/, (m) => "/api/v1/agentnet-panel/teams" + m[1]],
  [/^\/v1\/panel\/checks((?:\/\d+\/resolve)?)$/, (m) => "/api/v1/agentnet-panel/checks" + m[1]],
  [/^\/v1\/panel\/trails\/(search|stats)$/, (m) => "/api/v1/trails/" + m[1]],
  [/^\/v1\/panel\/(bgjobs(?:\/[A-Za-z0-9._-]+(?:\/file)?)?)$/, (m) => "/api/v1/" + m[1]],
  [/^\/v1\/panel\/(arsenal(?:\/(?:agent|roles))?)$/, (m) => "/api/v1/" + m[1]],
  [/^\/v1\/panel\/routing$/, () => "/api/v1/agent-routing"],
  [/^\/v1\/panel\/compact$/, () => "/api/v1/agent-compact"],
  [/^\/v1\/panel\/hooks((?:\/(?:nodes|stream|fires|rollback|templates|install-set|install|[A-Za-z0-9._:-]+\/enabled|[A-Za-z0-9._:-]+))?)$/, (m) => "/api/v1/agent-hooks" + m[1]],
  [/^\/v1\/panel\/update$/, () => "/api/v1/agent-update"],
  [/^\/v1\/panel\/update\/(check|run|stream)$/, (m) => "/api/v1/agent-update/" + m[1]],
  [/^\/v1\/panel\/director(\/(?:start|move|pick-folder|reset|answer))?$/, (m) => "/api/v1/agent-director" + (m[1] ?? "")],
  [/^\/v1\/panel\/adopt(\/(?:scan|cancel|plan|apply|rollback|clean))?$/, (m) => "/api/v1/agent-adopt" + (m[1] ?? "")],
  [/^\/v1\/panel\/summary$/, () => A + "summary"],
];

/** v1 path to legacy path, or null when it is not a v1 route (/v1/health is served directly and returns null here). */
export function toLegacy(path: string): string | null {
  for (const [re, to] of RULES) { const m = re.exec(path); if (m) return to(m); }
  return null;
}

/** Templated v1 paths, in this order. spec/openapi.yaml must list exactly these. */
export const V1_PATHS: string[] = [
  "/v1/health",
  ...["hello", "bye", "poll", "ack", "send", "inbox", "report", "status", "events", "gate"].map((x) => `/v1/agent/${x}`),
  "/v1/agent/trail/search", "/v1/agent/checks",
  "/v1/agent/tasks", "/v1/agent/tasks/{id}/{op}",
  "/v1/agent/agents", "/v1/agent/agents/{name}",
  "/v1/agent/teams", "/v1/agent/teams/{id}",
  ...["archive", "members", "messages", "tasks"].map((x) => `/v1/agent/teams/${"{id}"}/${x}`),
  "/v1/agent/teams/{id}/tasks/{tid}/{op}",
  "/v1/admin/spawn", "/v1/admin/plan-spawn", "/v1/admin/despawn", "/v1/admin/trail/inject", "/v1/admin/adopt/facts", "/v1/admin/adopt/report", "/v1/admin/adopt/apply", "/v1/admin/agents/{name}/placement", "/v1/admin/agents/{name}/grade",
  ...["snapshot", "stream", "usage", "scores", "discipline"].map((x) => `/v1/panel/${x}`), "/v1/panel/windows/close-all",
  ...["score", "tasks", "message", "open", "close", "schedules", "stop", "despawn", "run-schedule", "prompt", "feed"].map((x) => `/v1/panel/agents/{name}/${x}`),
  "/v1/panel/teams", "/v1/panel/teams/{id}",
  ...["archive", "members", "messages", "tasks"].map((x) => `/v1/panel/teams/${"{id}"}/${x}`),
  "/v1/panel/teams/{id}/tasks/{tid}/{op}",
  "/v1/panel/checks", "/v1/panel/checks/{id}/resolve",
  "/v1/panel/trails/search", "/v1/panel/trails/stats",
  "/v1/panel/summary", "/v1/panel/bgjobs", "/v1/panel/bgjobs/{id}", "/v1/panel/bgjobs/{id}/file",
  "/v1/panel/arsenal", "/v1/panel/arsenal/agent", "/v1/panel/arsenal/roles", "/v1/panel/routing", "/v1/panel/compact", "/v1/panel/hooks",
  "/v1/panel/hooks/nodes", "/v1/panel/hooks/stream", "/v1/panel/hooks/fires", "/v1/panel/hooks/{id}/enabled", "/v1/panel/hooks/rollback", "/v1/panel/hooks/templates", "/v1/panel/hooks/install", "/v1/panel/hooks/install-set", "/v1/panel/hooks/{id}",
  "/v1/panel/update", "/v1/panel/update/check", "/v1/panel/update/run", "/v1/panel/update/stream",
  "/v1/panel/adopt", "/v1/panel/adopt/scan", "/v1/panel/adopt/cancel", "/v1/panel/adopt/plan", "/v1/panel/adopt/apply", "/v1/panel/adopt/rollback", "/v1/panel/adopt/clean",
  "/v1/panel/director", "/v1/panel/director/start", "/v1/panel/director/move", "/v1/panel/director/pick-folder", "/v1/panel/director/reset", "/v1/panel/director/answer",
];

/** Legacy panel paths that change state. They are open to the page, so the server makes them root only (access.ts rootOnly). */
export const isPanelWrite = (method: string, path: string): boolean =>
  (method === "POST" || method === "PUT") && (
    /^\/api\/v1\/agentnet\/(agents\/[a-z0-9-]+\/(message|open|close|stop|despawn|run-schedule|prompt)|windows\/close-all)$/.test(path) ||
    path.startsWith("/api/v1/agentnet-panel/") ||
    path === "/api/v1/arsenal/roles" || path === "/api/v1/agent-routing" || path === "/api/v1/agent-compact" || path.startsWith("/api/v1/agent-hooks/") || path.startsWith("/api/v1/agent-update/") || path === "/api/v1/agent-director/start" || path === "/api/v1/agent-director/move" || path === "/api/v1/agent-director/pick-folder" || path === "/api/v1/agent-director/reset" || path === "/api/v1/agent-director/answer" || path.startsWith("/api/v1/agent-adopt/"));
