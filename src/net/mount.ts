// /v1/* paths are a URL rewrite in front of the existing handlers: one store, one waiters map, one auth rule.
const A = "/api/v1/agentnet/";
const TEAM = "teams(?:/[a-z0-9-]+(?:/(?:archive|members|messages|tasks(?:/\\d+/(?:start|done|claim))?))?)?";
const RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^\/v1\/agent\/(hello|bye|poll|ack|send|inbox|report|status|events|checks|gate|trail\/search)$/, (m) => A + m[1]],
  [/^\/v1\/agent\/(tasks(?:\/\d+\/(?:start|done))?)$/, (m) => A + m[1]],
  [/^\/v1\/agent\/(plan|jobs|steps(?:\/done|\/\d+\/drop)?)$/, (m) => A + m[1]],
  [/^\/v1\/agent\/(agents(?:\/[a-z0-9-]+)?)$/, (m) => A + m[1]],
  [new RegExp(`^/v1/agent/(${TEAM})$`), (m) => A + m[1]],
  [/^\/v1\/admin\/(spawn|plan-spawn|despawn|trail\/inject|adopt\/(?:facts|report|apply))$/, (m) => A + m[1]],
  [/^\/v1\/admin\/(agents\/[a-z0-9-]+\/(?:placement|grade|asks\/\d+\/close))$/, (m) => A + m[1]],
  [/^\/v1\/admin\/(agent-lines(?:\/[a-z0-9-]+)?)$/, (m) => A + m[1]],
  [/^\/v1\/panel\/lines((?:\/[a-z0-9-]+(?:\/[a-z0-9-]+\/[a-z]+|\/[a-z]+)?)?)$/, (m) => "/api/v1/agentnet-panel/lines" + m[1]],
  [/^\/v1\/panel\/(snapshot|stream|watch|usage|scores|discipline|metrics|windows\/close-all)$/, (m) => A + m[1]],
  [/^\/v1\/panel\/(agents\/[a-z0-9-]+\/(?:score|tasks|message|open|close|schedules|stop|despawn|run-schedule|prompt|send-now|feed|image|file|ref|history|mcp))$/, (m) => A + m[1]],
  [/^\/v1\/panel\/teams((?:\/[a-z0-9-]+(?:\/(?:archive|members|messages|tasks(?:\/\d+\/(?:start|done|claim))?))?)?)$/, (m) => "/api/v1/agentnet-panel/teams" + m[1]],
  [/^\/v1\/panel\/checks((?:\/\d+\/resolve)?)$/, (m) => "/api/v1/agentnet-panel/checks" + m[1]],
  [/^\/v1\/panel\/(goals(?:\/usage|\/\d+\/(?:missing|heart))?|items\/\d+\/mark)$/, (m) => "/api/v1/agentnet-panel/" + m[1]],
  [/^\/v1\/panel\/trails\/(search|stats)$/, (m) => "/api/v1/trails/" + m[1]],
  [/^\/v1\/panel\/(bgjobs(?:\/[A-Za-z0-9._-]+(?:\/file)?)?)$/, (m) => "/api/v1/" + m[1]],
  [/^\/v1\/panel\/(arsenal(?:\/(?:agent|roles))?)$/, (m) => "/api/v1/" + m[1]],
  [/^\/v1\/panel\/brains(\/import)?$/, (m) => "/api/v1/brains" + (m[1] ?? "")],
  [/^\/v1\/panel\/evals$/, () => "/api/v1/evals/summary"],
  [/^\/v1\/panel\/routing$/, () => "/api/v1/agent-routing"],
  [/^\/v1\/panel\/compact$/, () => "/api/v1/agent-compact"],
  [/^\/v1\/panel\/hooks((?:\/(?:nodes|stream|fires|rollback|templates|install-set|install|[A-Za-z0-9._:-]+\/enabled|[A-Za-z0-9._:-]+))?)$/, (m) => "/api/v1/agent-hooks" + m[1]],
  [/^\/v1\/panel\/update$/, () => "/api/v1/agent-update"],
  [/^\/v1\/panel\/update\/(check|run|stream)$/, (m) => "/api/v1/agent-update/" + m[1]],
  [/^\/v1\/panel\/director(\/(?:start|move|pick-folder|reset|answer))?$/, (m) => "/api/v1/agent-director" + (m[1] ?? "")],
  [/^\/v1\/panel\/adopt(\/(?:scan|cancel|plan|apply|rollback|clean))?$/, (m) => "/api/v1/agent-adopt" + (m[1] ?? "")],
  [/^\/v1\/panel\/summary$/, () => A + "summary"],
  [/^\/v1\/panel\/agent-import(\/(?:proposal|scan|cancel|decide|preview|apply|rollback|stream))?$/, (m) => "/api/v1/agent-import" + (m[1] ?? "")],
  [/^\/v1\/panel\/accounts(\/[a-z0-9-]{1,32})?$/, (m) => "/api/v1/accounts" + (m[1] ?? "")],
  [/^\/v1\/panel\/pair\/(requests|approve|deny)$/, (m) => "/api/v1/pair/" + m[1]],
  [/^\/v1\/panel\/devices(\/[A-Za-z0-9_-]{1,32})?$/, (m) => "/api/v1/pair/devices" + (m[1] ?? "")],
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
  "/v1/agent/plan", "/v1/agent/steps", "/v1/agent/steps/done", "/v1/agent/steps/{n}/drop", "/v1/agent/jobs",
  "/v1/agent/agents", "/v1/agent/agents/{name}",
  "/v1/agent/teams", "/v1/agent/teams/{id}",
  ...["archive", "members", "messages", "tasks"].map((x) => `/v1/agent/teams/${"{id}"}/${x}`),
  "/v1/agent/teams/{id}/tasks/{tid}/{op}",
  "/v1/admin/spawn", "/v1/admin/plan-spawn", "/v1/admin/despawn", "/v1/admin/trail/inject", "/v1/admin/adopt/facts", "/v1/admin/adopt/report", "/v1/admin/adopt/apply", "/v1/admin/agents/{name}/placement", "/v1/admin/agents/{name}/grade", "/v1/admin/agents/{name}/asks/{msg}/close", "/v1/admin/agent-lines", "/v1/admin/agent-lines/{line}",
  "/v1/panel/lines", "/v1/panel/lines/proposals", "/v1/panel/lines/proposals/{id}/{op}", "/v1/panel/lines/{line}", "/v1/panel/lines/{line}/{op}",
  ...["snapshot", "stream", "watch", "usage", "scores", "discipline", "metrics"].map((x) => `/v1/panel/${x}`), "/v1/panel/windows/close-all",
  ...["score", "tasks", "message", "open", "close", "schedules", "stop", "despawn", "run-schedule", "prompt", "send-now", "feed", "image", "file", "ref", "history", "mcp"].map((x) => `/v1/panel/agents/{name}/${x}`),
  "/v1/panel/teams", "/v1/panel/teams/{id}",
  ...["archive", "members", "messages", "tasks"].map((x) => `/v1/panel/teams/${"{id}"}/${x}`),
  "/v1/panel/teams/{id}/tasks/{tid}/{op}",
  "/v1/panel/checks", "/v1/panel/checks/{id}/resolve", "/v1/panel/goals", "/v1/panel/goals/usage", "/v1/panel/goals/{id}/missing", "/v1/panel/goals/{id}/heart", "/v1/panel/items/{id}/mark",
  "/v1/panel/trails/search", "/v1/panel/trails/stats",
  "/v1/panel/summary", "/v1/panel/bgjobs", "/v1/panel/bgjobs/{id}", "/v1/panel/bgjobs/{id}/file",
  "/v1/panel/arsenal", "/v1/panel/arsenal/agent", "/v1/panel/arsenal/roles", "/v1/panel/brains", "/v1/panel/brains/import", "/v1/panel/evals", "/v1/panel/routing", "/v1/panel/compact", "/v1/panel/hooks",
  "/v1/panel/hooks/nodes", "/v1/panel/hooks/stream", "/v1/panel/hooks/fires", "/v1/panel/hooks/{id}/enabled", "/v1/panel/hooks/rollback", "/v1/panel/hooks/templates", "/v1/panel/hooks/install", "/v1/panel/hooks/install-set", "/v1/panel/hooks/{id}",
  "/v1/panel/update", "/v1/panel/update/check", "/v1/panel/update/run", "/v1/panel/update/stream",
  "/v1/panel/adopt", "/v1/panel/adopt/scan", "/v1/panel/adopt/cancel", "/v1/panel/adopt/plan", "/v1/panel/adopt/apply", "/v1/panel/adopt/rollback", "/v1/panel/adopt/clean",
  "/v1/panel/director", "/v1/panel/director/start", "/v1/panel/director/move", "/v1/panel/director/pick-folder", "/v1/panel/director/reset", "/v1/panel/director/answer",
  "/v1/panel/agent-import", ...["proposal", "scan", "cancel", "decide", "preview", "apply", "rollback", "stream"].map((x) => `/v1/panel/agent-import/${x}`),
  "/v1/panel/accounts", "/v1/panel/accounts/{id}",
  "/v1/pair/start", "/v1/pair/poll", "/v1/panel/pair/requests", "/v1/panel/pair/approve", "/v1/panel/pair/deny", "/v1/panel/devices", "/v1/panel/devices/{id}",
];

/** Legacy panel paths that change state. They are open to the page, so the server makes them root only (access.ts rootOnly). */
export const isPanelWrite = (method: string, path: string): boolean =>
  (method === "POST" || method === "PUT") && (
    /^\/api\/v1\/agentnet\/(agents\/[a-z0-9-]+\/(message|open|close|stop|despawn|run-schedule|prompt|send-now|image|mcp)|windows\/close-all)$/.test(path) ||
    path.startsWith("/api/v1/agentnet-panel/") ||
    path === "/api/v1/arsenal/roles" || path === "/api/v1/brains/import" || path === "/api/v1/agent-routing" || path === "/api/v1/agent-compact" || path.startsWith("/api/v1/agent-hooks/") || path.startsWith("/api/v1/agent-update/") || path === "/api/v1/agent-director/start" || path === "/api/v1/agent-director/move" || path === "/api/v1/agent-director/pick-folder" || path === "/api/v1/agent-director/reset" || path === "/api/v1/agent-director/answer" || path.startsWith("/api/v1/agent-adopt/") || path.startsWith("/api/v1/agent-import/"));
