// Panel login: `agentnet login` asks for a one-time code (POST /api/v1/login/code), the link /login?code= turns it into a
// cookie session (only its sha256 is stored), POST /api/v1/logout ends it.
import type { Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { problem, type Env } from "../core/http";
import { audit } from "../core/logger";
import { CODE_TTL_S, SESSION_COOKIE, SESSION_MAX_S, createSession, deleteSession, newLoginCode, overHttps, sameOrigin, sessionOf, useLoginCode } from "../core/auth";

// Mock A (docs/internal/one-folder/mock.html): one title, one line, the command with a copy button. Inline CSS only, light and dark
// from prefers-color-scheme, no external request; the only script is the copy button.
const page = (title: string, text: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${title} · agentnet</title>
<style>
:root{--bg:#0b0d10;--card:#14181d;--line:#262c34;--ink:#e6e8eb;--muted:#9aa3ad;--track:#1c2026;--on:#3ddc84}
@media (prefers-color-scheme:light){:root{--bg:#f4f5f7;--card:#fff;--line:#dfe3e8;--ink:#14181d;--muted:#5b6570;--track:#eef0f3;--on:#14883e}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{width:100%;max-width:26rem;padding:28px 24px;border:1px solid var(--line);border-radius:18px;background:var(--card)}
.mk{display:flex;align-items:center;gap:8px;margin-bottom:18px;color:var(--muted);font:600 13px/1 system-ui,sans-serif;letter-spacing:.02em}.mk i{width:10px;height:10px;border-radius:50%;background:var(--on)}
h1{margin:0 0 8px;font-size:22px;line-height:1.25}p{margin:0 0 18px;color:var(--muted);font-size:15px}
.cmd{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 14px;border:1px solid var(--line);border-radius:12px;background:var(--track)}
code{flex:1;min-width:0;font:15px ui-monospace,SFMono-Regular,Menlo,monospace;user-select:all;overflow-wrap:anywhere}
button{min-height:44px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font:600 14px system-ui,sans-serif;cursor:pointer}
button:focus-visible{outline:2px solid var(--on);outline-offset:2px}
</style></head><body><main><div class="mk"><i></i>agentnet</div><h1>${title}</h1><p>${text}</p>
<div class="cmd"><code id="c">agentnet login</code><button type="button" id="b" aria-label="Copy command">Copy</button></div></main>
<script>document.getElementById("b").onclick=function(){var b=this;navigator.clipboard.writeText("agentnet login").then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1600)},function(){b.textContent="Select and copy"})}</script>
</body></html>`;
const SIGN_IN = page("Sign in to agentnet", `Run this on the machine that runs agentnet. It prints a link that works once, for ${CODE_TTL_S} seconds.`);
const EXPIRED = page("This link has expired", "Links work once, for a short time. Run this on the machine that runs agentnet for a new one.");
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
