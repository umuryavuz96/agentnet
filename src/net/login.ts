// Panel login: `agentnet login` asks for a one-time code (POST /api/v1/login/code), the link /login?code= turns it into a
// cookie session (only its sha256 is stored), POST /api/v1/logout ends it.
import type { Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { problem, type Env } from "../core/http";
import { audit } from "../core/logger";
import { CODE_TTL_S, SESSION_COOKIE, SESSION_MAX_S, createSession, deleteSession, newLoginCode, overHttps, sameOrigin, sessionOf, useLoginCode } from "../core/auth";

const page = (title: string, text: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e8eb;font:16px/1.5 system-ui,sans-serif}main{max-width:32rem;padding:24px}code{background:#1c2026;padding:2px 6px;border-radius:4px}</style>
</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
const SIGN_IN = page("Sign in", "Sign in: run <code>agentnet login</code> on the machine that runs agentnet.");
const EXPIRED = page("Link expired", "This link has expired or was already used. On the machine that runs agentnet, run <code>agentnet login</code> for a new link.");
const htmlHeaders = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" };

/** The origin the caller used (https when a proxy says so), for the printed link. */
export function originOf(c: Context): string {
  const u = new URL(c.req.url), host = c.req.header("host") ?? u.host;
  return `${overHttps(c) ? "https" : u.protocol.replace(":", "")}://${host}`;
}

/** POST /api/v1/login/code and POST /api/v1/logout, on the api app (requireAuth already ran). */
export function loginApiRoutes(api: Hono<Env>) {
  api.post("/login/code", (c) => {
    const k = c.get("auth"); // a panel or root bearer, or a valid session from the same origin; not an agent token, not the loopback flag
    if (k !== "token" && !(k === "session" && sameOrigin(c))) return problem(c, 403, "Forbidden", "a panel token or a signed-in session is needed");
    const code = newLoginCode();
    audit(c.get("actor"), "login.code", "panel", "ok", c.get("trace"));
    return c.json({ code, url: `${originOf(c)}/login?code=${code}`, expiresIn: CODE_TTL_S });
  });
  api.post("/logout", (c) => {
    deleteSession(sessionOf(c));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });
}

/** GET /login (top level, open): a valid code sets the cookie and goes to /; else a short page with status 401 (or 200 with no code). */
export function loginPageRoute(app: Hono<Env>) {
  app.get("/login", (c) => {
    const code = c.req.query("code");
    if (code === undefined || code === "") return c.body(SIGN_IN, 200, htmlHeaders);
    if (!useLoginCode(code)) return c.body(EXPIRED, 401, htmlHeaders);
    const id = createSession(c.req.header("user-agent") ?? null);
    setCookie(c, SESSION_COOKIE, id, { httpOnly: true, sameSite: "Strict", path: "/", maxAge: SESSION_MAX_S, secure: overHttps(c) });
    audit("panel", "login.session", "panel", "ok", c.get("trace"));
    c.header("Cache-Control", "no-store");
    return c.redirect("/", 302);
  });
}
