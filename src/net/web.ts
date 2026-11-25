import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
import { problem, type Env } from "../core/http";

const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg" };
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'self'";

// The page a chat's live-UI frame loads (web/src/components/ChatSandbox.vue). It waits for one message from the page that
// framed it and writes that document into itself. Its policy is the wall: `sandbox allow-scripts` gives it an opaque origin
// even when opened directly (no cookies, no storage, nothing of the app), and `default-src 'none'` leaves it no network at
// all: no fetch, socket, remote image, font, script, frame or form post. Only inline script and style, and data: media.
export const SANDBOX_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
export const SANDBOX_SHELL = `<!doctype html><meta charset="utf-8"><title>Live UI</title><script>addEventListener("message",function f(e){var d=e.data;if(e.source!==parent||!d||d.agentnetSandbox!==1||d.t!=="init"||typeof d.doc!=="string")return;removeEventListener("message",f);document.open();document.write(d.doc);document.close()});parent.postMessage({agentnetSandbox:1,t:"ready"},"*")</script>`;

/** Serve web/dist: "/sandbox.html" → the live-UI shell above; "/" and "/index.html" → index.html; "/assets/*" → the file (immutable cache, 1 year);
 *  any other GET whose path does not start with "/v1/" or "/api/" → index.html (SPA fallback, no-cache).
 *  When web/dist/index.html is missing: GET "/" → 503 problem "web app not built: run bun run web:build". */
export function webRoutes(app: Hono<Env>, distDir?: string): void {
  const dist = () => distDir ?? process.env.AGENTNET_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
  const html = async (c: Context<Env>) => {
    const f = Bun.file(join(dist(), "index.html"));
    if (!(await f.exists())) return problem(c, 503, "Service Unavailable", "web app not built: run bun run web:build");
    return new Response(f, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": CSP } });
  };
  app.get("/assets/:name", (c) => {
    const name = c.req.param("name");
    if (!name || /[\\/\0]|\.\./.test(name)) return problem(c, 404, "Not Found", "no such file");
    const p = join(dist(), "assets", name);
    if (!existsSync(p)) return problem(c, 404, "Not Found", "no such file");
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    return new Response(Bun.file(p), { headers: { "Content-Type": TYPES[ext] ?? "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } });
  });
  app.get("/sandbox.html", () => new Response(SANDBOX_SHELL, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "Content-Security-Policy": SANDBOX_CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" } }));
  app.get("/", html);
  app.get("/index.html", html);
  app.get("*", (c) => (/^\/(v1|api)\//.test(c.req.path) || c.req.path.startsWith("/assets/") ? problem(c, 404, "Not Found", "no such route") : html(c)));
}
