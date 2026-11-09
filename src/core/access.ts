import type { Context, MiddlewareHandler } from "hono";
import { bearer, problem, type Env } from "./http";
import { rootByToken } from "../net/routes";

/** Peer address from Bun.serve: Hono passes the Bun server as c.env. null when unknown (app.request() without env) = not loopback. */
export function peerOf(c: Context): string | null {
  const s = c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined;
  try { return s?.requestIP?.(c.req.raw)?.address ?? null; } catch { return null; }
}

const v4 = (a: string): number[] | null => {
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(a); // no leading zeros: some resolvers read 010 as octal
  if (!m) return null;
  const n = m.slice(1).map(Number);
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
};

/** 127.0.0.0/8, ::1, ::ffff:127.x.x.x */
export function isLoopbackAddr(a: string | null): boolean {
  if (!a) return false;
  const l = a.toLowerCase();
  if (l === "::1") return true;
  const n = v4(l.startsWith("::ffff:") ? l.slice(7) : l);
  return !!n && n[0] === 127;
}
/** A proxy in front (Caddy, tailscale serve) connects from 127.0.0.1 for every client. These headers mean the peer is not the real caller. */
const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "via"];
export const hasProxyHeader = (c: Context) => PROXY_HEADERS.some((h) => c.req.header(h) !== undefined);
/** Loopback peer and no proxy header. */
export const isLoopback = (c: Context) => isLoopbackAddr(peerOf(c)) && !hasProxyHeader(c);

/** Allowed bind hosts: "localhost", "::1", 127/8, 10/8, 172.16/12, 192.168/16, 100.64/10, fd7a:115c:a1e0::/48. Everything else is false,
 *  including 0.0.0.0, ::, public addresses and hostnames other than localhost. */
export function bindOk(host: string): boolean {
  if (host === "localhost") return true;
  const n = v4(host);
  if (n) {
    const [a, b] = n;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = host.toLowerCase();
  return l === "::1" || l.startsWith("fd7a:115c:a1e0:");
}

/** For root-only routes outside the agent router (config writes in phase 5b): loopback peer, or Bearer = the live root agent's token. Else 403. */
export const rootOnly: MiddlewareHandler<Env> = async (c, next) => {
  const t = bearer(c);
  if (!isLoopback(c) && !(t && rootByToken(t))) return problem(c, 403, "Forbidden", "root only");
  await next();
};
