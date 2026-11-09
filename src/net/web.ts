import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
import { problem, type Env } from "../core/http";

const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'";

/** Serve web/dist: "/" and "/index.html" → index.html; "/assets/*" → the file (immutable cache, 1 year);
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
  app.get("/", html);
  app.get("/index.html", html);
  app.get("*", (c) => (/^\/(v1|api)\//.test(c.req.path) || c.req.path.startsWith("/assets/") ? problem(c, 404, "Not Found", "no such route") : html(c)));
}
