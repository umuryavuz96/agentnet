// Device pairing, shaped like the OAuth 2.0 Device Authorization Grant (RFC 8628) that `gh auth login` and TV sign-ins use:
//   POST /v1/pair/start {name}        open: a short user code for the owner, a long device code for the app, expiry, poll interval
//   POST /v1/pair/poll  {device_code} open: 400 authorization_pending | access_denied | expired_token | invalid_grant, or 200 with a token
//   the owner (panel token, device token or a same-origin login) lists, approves or denies under /api/v1/pair/*.
// Pending requests live in memory (10 min). Device tokens are panel-scoped, stored as sha256 only, revocable.
import type { Context, Hono } from "hono";
import { problem, type Env } from "../core/http";
import { rootOnly, isLoopbackAddr, peerOf } from "../core/access";
import { db, schema } from "../core/db";
import { audit } from "../core/logger";
import { originOf } from "./login";

export const PAIR_TTL_S = 600, PAIR_INTERVAL_S = 5, START_LIMIT = 5, START_WINDOW_MS = 60_000, MAX_PENDING = 50;
/** Injectable clock (tests move it). */
export const pairClock = { now: () => Date.now() };

const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
// RFC 8628 §6.1: base-20 consonants, no vowels (no words), no lookalikes; shown as XXXX-XXXX.
const ALPHA = "BCDFGHJKLMNPQRSTVWXZ";
const userCode = () => { const b = crypto.getRandomValues(new Uint8Array(8)); const s = [...b].map((x) => ALPHA[x % 20]).join(""); return `${s.slice(0, 4)}-${s.slice(4)}`; };
const normCode = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");

type Pending = { device: string; user: string; name: string; created: number; expires: number; state: "pending" | "approved" | "denied"; token?: string; deviceId?: string };
const pending = new Map<string, Pending>(); // device code -> request
const starts = new Map<string, number[]>(); // address -> start times in the window

function sweep(now: number) {
  for (const [k, p] of pending) if (p.expires + PAIR_TTL_S * 1000 <= now) pending.delete(k); // keep expired ones a while so the poll can say expired_token
  for (const [k, t] of starts) { const live = t.filter((x) => x > now - START_WINDOW_MS); if (live.length) starts.set(k, live); else starts.delete(k); }
}
/** The caller's address: a local proxy's X-Forwarded-For first hop, else the peer. A direct peer never chooses its own address. */
const callerAddr = (c: Context) => {
  const peer = peerOf(c);
  return (isLoopbackAddr(peer) && c.req.header("x-forwarded-for")?.split(",")[0]?.trim()) || peer || "unknown";
};
const byUser = (code: string, now: number) => [...pending.values()].find((p) => p.user === code && p.state === "pending" && p.expires > now);

// ---------- device tokens ----------
schema("CREATE TABLE IF NOT EXISTS device_tokens (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER)");
/** True for a live device token; marks its last use (at most once a minute). */
export function isDeviceToken(t: string): boolean {
  if (!t) return false;
  const h = sha(t), row = db().query("SELECT id, last_used FROM device_tokens WHERE token_hash = ?").get(h) as { id: string; last_used: number | null } | null;
  if (!row) return false;
  const now = pairClock.now();
  if (!row.last_used || now - row.last_used > 60_000) db().run("UPDATE device_tokens SET last_used = ? WHERE id = ?", [now, row.id]);
  return true;
}
function mintDevice(name: string): { id: string; token: string } {
  const id = random().slice(0, 12), token = random();
  db().run("INSERT INTO device_tokens (id, token_hash, name, created, last_used) VALUES (?, ?, ?, ?, NULL)", [id, sha(token), name, pairClock.now()]);
  return { id, token };
}
export const listDevices = () => db().query("SELECT id, name, created, last_used FROM device_tokens ORDER BY created DESC").all() as { id: string; name: string; created: number; last_used: number | null }[];
/** The device id behind a live device token, or null (no last-use mark: streams call it once at open). */
export const deviceIdOf = (t: string): string | null => (t ? (db().query("SELECT id FROM device_tokens WHERE token_hash = ?").get(sha(t)) as { id: string } | null)?.id ?? null : null);
const revokeListeners = new Set<(id: string) => void>();
/** Called with the device id on every revoke; open streams use it to close at once. Returns the unsubscribe. */
export const onRevoke = (fn: (id: string) => void) => { revokeListeners.add(fn); return () => { revokeListeners.delete(fn); }; };
export const revokeDevice = (id: string): boolean => {
  const gone = db().run("DELETE FROM device_tokens WHERE id = ?", [id]).changes > 0;
  if (gone) for (const fn of revokeListeners) fn(id);
  return gone;
};
/** Pending requests for the owner (no device codes). */
export const pendingPairs = () => { const now = pairClock.now(); return [...pending.values()].filter((p) => p.state === "pending" && p.expires > now).map((p) => ({ user_code: p.user, name: p.name, created: p.created, expires: p.expires })); };

const oauthErr = (c: Context, error: string, status = 400) => c.json({ error }, status as 400);

/** POST /v1/pair/start and /v1/pair/poll, on the top app (no credential). */
export function pairOpenRoutes(app: Hono<Env>) {
  app.post("/v1/pair/start", async (c) => {
    const now = pairClock.now(); sweep(now);
    const addr = callerAddr(c), hits = starts.get(addr) ?? [];
    if (hits.length >= START_LIMIT || pending.size >= MAX_PENDING) { c.header("Retry-After", "60"); return problem(c, 429, "Too Many Requests", "too many pairing requests; try again in a minute"); }
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    if (!name) return problem(c, 400, "Bad Request", "name is required");
    starts.set(addr, [...hits, now]);
    let user = userCode(); while ([...pending.values()].some((p) => p.user === user)) user = userCode();
    const p: Pending = { device: random(), user, name, created: now, expires: now + PAIR_TTL_S * 1000, state: "pending" };
    pending.set(p.device, p);
    audit("anonymous", "pair.start", name, "ok", c.get("trace"), { addr });
    const uri = `${originOf(c)}/#/pair`;
    return c.json({ device_code: p.device, user_code: user, verification_uri: uri, verification_uri_complete: `${uri}?code=${user}`, expires_in: PAIR_TTL_S, interval: PAIR_INTERVAL_S });
  });
  app.post("/v1/pair/poll", async (c) => {
    const now = pairClock.now();
    const body = (await c.req.json().catch(() => ({}))) as { device_code?: unknown };
    const p = pending.get(String(body.device_code ?? ""));
    if (!p) return oauthErr(c, "invalid_grant");
    if (p.state === "denied") { pending.delete(p.device); return oauthErr(c, "access_denied"); }
    if (p.state === "approved" && p.token) { pending.delete(p.device); return c.json({ access_token: p.token, token_type: "bearer", device_id: p.deviceId, name: p.name }); }
    if (p.expires <= now) { pending.delete(p.device); return oauthErr(c, "expired_token"); }
    return oauthErr(c, "authorization_pending");
  });
}

/** Owner routes on the api app (requireAuth already ran; rootOnly keeps agent tokens out of reads too). */
export function pairPanelRoutes(api: Hono<Env>) {
  api.get("/pair/requests", rootOnly, (c) => c.json({ requests: pendingPairs() }));
  const decide = (state: "approved" | "denied") => async (c: Context<Env>) => {
    const body = (await c.req.json().catch(() => ({}))) as { user_code?: unknown };
    const p = byUser(normCode(body.user_code), pairClock.now());
    if (!p) return problem(c, 404, "Not Found", "no open pairing request with that code (it may have expired)");
    p.state = state;
    if (state === "approved") { const d = mintDevice(p.name); p.token = d.token; p.deviceId = d.id; }
    audit(c.get("actor"), `pair.${state === "approved" ? "approve" : "deny"}`, p.name, "ok", c.get("trace"));
    return c.json({ ok: true, name: p.name, state, device_id: p.deviceId ?? null });
  };
  api.post("/pair/approve", rootOnly, decide("approved"));
  api.post("/pair/deny", rootOnly, decide("denied"));
  api.get("/pair/devices", rootOnly, (c) => c.json({ devices: listDevices() }));
  api.delete("/pair/devices/:id", rootOnly, (c) => {
    const id = c.req.param("id");
    if (!revokeDevice(id)) return problem(c, 404, "Not Found", "no such device");
    audit(c.get("actor"), "pair.revoke", id, "ok", c.get("trace"));
    return c.json({ revoked: id });
  });
}
