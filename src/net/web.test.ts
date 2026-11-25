import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../core/http";
import { SANDBOX_CSP, SANDBOX_SHELL, webRoutes } from "./web";

const app = new Hono<Env>();
webRoutes(app, "/nonexistent-dist");

test("the live-UI shell is served with its own policy: sandboxed, no network", async () => {
  const r = await app.request("/sandbox.html");
  expect(r.status).toBe(200);
  expect(await r.text()).toBe(SANDBOX_SHELL);
  const csp = r.headers.get("Content-Security-Policy")!;
  expect(csp).toBe(SANDBOX_CSP);
  const d = Object.fromEntries(csp.split(";").map((x) => { const [k, ...v] = x.trim().split(/\s+/); return [k!, v.join(" ")]; }));
  expect(d.sandbox).toBe("allow-scripts"); // an opaque origin: never allow-same-origin, forms, popups or top navigation
  expect(d["default-src"]).toBe("'none'");
  expect(d["script-src"]).toBe("'unsafe-inline'");
  expect(d["form-action"]).toBe("'none'");
  expect(d["base-uri"]).toBe("'none'");
  for (const k of ["connect-src", "frame-src", "child-src", "worker-src", "object-src"]) expect(d[k]).toBeUndefined(); // they fall back to 'none'
  for (const [k, v] of Object.entries(d)) if (k !== "sandbox") expect(v).not.toMatch(/https?:|\*|'self'(?!$)/); // no host is ever allowed
  expect(d["frame-ancestors"]).toBe("'self'");
});

test("the shell holds no address and takes its document only from the page that framed it", () => {
  expect(SANDBOX_SHELL).not.toMatch(/https?:\/\//);
  expect(SANDBOX_SHELL).toContain("e.source!==parent");
});
