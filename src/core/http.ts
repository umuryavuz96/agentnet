// HTTP plumbing shared by every route: trace ids, request logging, RFC 9457 errors.
import type { Context, MiddlewareHandler } from "hono";
import { fromTraceparent, logEvent, traceparent, type Trace } from "./logger";

export type Env = { Variables: { trace: Trace; actor: string } };

/** RFC 9457 problem details. */
export function problem(c: Context, status: number, title: string, detail?: string) {
  return c.body(JSON.stringify({ type: "about:blank", title, status, detail, trace_id: c.get("trace")?.trace_id }), status as 400,
    { "Content-Type": "application/problem+json" });
}

/** Trace id per request (continues a W3C traceparent if the caller sent one) + one structured log line. */
export const tracing: MiddlewareHandler<Env> = async (c, next) => {
  const trace = fromTraceparent(c.req.header("traceparent"));
  c.set("trace", trace);
  c.set("actor", "anonymous");
  const t0 = performance.now();
  await next();
  c.header("traceparent", traceparent(trace));
  const ms = Math.round(performance.now() - t0);
  // Mutations at info; reads only at debug (the apps poll), but always when they fail or are slow.
  const level = c.res.status >= 500 ? "error" : c.req.method !== "GET" || c.res.status >= 400 || ms > 2000 ? "info" : "debug";
  logEvent(level, `${c.req.method} ${c.req.path} ${c.res.status}`, { "http.method": c.req.method, "http.route": c.req.path, "http.status_code": c.res.status, duration_ms: ms, actor: c.get("actor") }, trace);
};

export const bearer = (c: Context) => {
  const h = c.req.header("authorization") ?? "";
  // ?token= for EventSource clients that can't set headers
  return h.startsWith("Bearer ") ? h.slice(7).trim() : (c.req.query("token") ?? "");
};

/** agentnet has no login. Agent routes check their own token (routes.ts). Kept so moved callers and tests compile. */
export const requireAuth = (_open: (path: string) => boolean): MiddlewareHandler<Env> => async (_c, next) => { await next(); };
