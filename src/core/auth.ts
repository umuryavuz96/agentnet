// Panel and root credentials: run/root.token, run/panel.token (0600 in a 0700 run/), one-time login codes, cookie sessions.
// Default secure: every API route needs a credential. Two house flags bring back the old loopback trust, one each:
//   AGENTNET_LOOPBACK_ROOT=on  a loopback request with no token or an unknown token on an agent route acts as root
//   AGENTNET_PANEL_LOGIN=off   a loopback request with no credential may read and write the panel routes
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { ROOT } from "./config";
import { db, schema } from "./db";

export const SESSION_COOKIE = "agentnet_session";
export const SESSION_MAX_S = 30 * 24 * 3600;
export const CODE_TTL_S = 60;
/** Injectable clock and code lifetime (tests shrink them). */
export const authClock = { now: () => Date.now(), codeTtlMs: CODE_TTL_S * 1000 };

const runDir = () => join(ROOT, "run");
const rootFile = () => join(runDir(), "root.token");
const panelFile = () => join(runDir(), "panel.token");
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** Create run/ (0700), run/agentnet/ (0700) and both tokens (0600) when missing. Never rewrites an existing token. */
export function ensureSecrets(): void {
  for (const d of [runDir(), join(runDir(), "agentnet")]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
  for (const f of [rootFile(), panelFile()]) {
    if (!existsSync(f)) writeFileSync(f, random() + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(f, 0o600);
  }
}

const read = (f: string): string => { try { return readFileSync(f, "utf8").trim(); } catch { return ""; } };
const same = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export const isRootToken = (t: string): boolean => same(t, read(rootFile()));
export const isPanelToken = (t: string): boolean => same(t, read(panelFile()));
export const panelToken = (): string => read(panelFile());

/** House flags, read on every request so tests and config/env can switch them. */
export const loopbackRoot = () => process.env.AGENTNET_LOOPBACK_ROOT === "on";
export const panelLoginOff = () => process.env.AGENTNET_PANEL_LOGIN === "off";
export const houseFlags = (): string[] => [...(loopbackRoot() ? ["AGENTNET_LOOPBACK_ROOT=on"] : []), ...(panelLoginOff() ? ["AGENTNET_PANEL_LOGIN=off"] : [])];
/** AGENTNET_LOOPBACK_ROOT is deprecated (step 7): it still works in this release, logs this at boot and shows it in the panel. */
export const LOOPBACK_DEPRECATION = "deprecated: removed in 0.8; local scripts must send run/root.token";
let loopbackHits = 0;
/** Requests that became root through the loopback fallback since boot: root watches it fall to 0 as house scripts move to the token. */
export const countLoopbackHit = () => { loopbackHits++; };
export const loopbackRootHits = () => loopbackHits;
/** Deprecation lines for the panel's banner and /health. */
export const deprecations = (): string[] => (loopbackRoot() ? [`AGENTNET_LOOPBACK_ROOT=on: ${LOOPBACK_DEPRECATION}`] : []);

// ---------- one-time login codes (memory only) ----------
const codes = new Map<string, number>(); // code -> expiry ms
export function newLoginCode(): string {
  const now = authClock.now();
  for (const [k, exp] of codes) if (exp <= now) codes.delete(k);
  const code = random();
  codes.set(code, now + authClock.codeTtlMs);
  return code;
}
/** True once per valid, unexpired code. */
export function useLoginCode(code: string): boolean {
  const exp = codes.get(code);
  if (exp === undefined) return false;
  codes.delete(code);
  return exp > authClock.now();
}

// ---------- cookie sessions (only the sha256 of the id is stored) ----------
schema("CREATE TABLE IF NOT EXISTS panel_sessions (id_hash TEXT PRIMARY KEY, created INTEGER NOT NULL, last_seen INTEGER NOT NULL, ua TEXT)");
export function createSession(ua: string | null): string {
  const id = random(), now = authClock.now();
  db().run("INSERT INTO panel_sessions (id_hash, created, last_seen, ua) VALUES (?, ?, ?, ?)", [sha(id), now, now, ua?.slice(0, 200) ?? null]);
  return id;
}
export function sessionValid(id: string | undefined): boolean {
  if (!id) return false;
  const h = sha(id), row = db().query("SELECT created FROM panel_sessions WHERE id_hash = ?").get(h) as { created: number } | null;
  if (!row) return false;
  const now = authClock.now();
  if (now - row.created > SESSION_MAX_S * 1000) { db().run("DELETE FROM panel_sessions WHERE id_hash = ?", [h]); return false; }
  db().run("UPDATE panel_sessions SET last_seen = ? WHERE id_hash = ?", [now, h]);
  return true;
}
export const deleteSession = (id: string | undefined) => { if (id) db().run("DELETE FROM panel_sessions WHERE id_hash = ?", [sha(id)]); };
export const sessionCount = (): number => (db().query("SELECT COUNT(*) AS n FROM panel_sessions").get() as { n: number }).n;
export const sessionOf = (c: Context): string | undefined => getCookie(c, SESSION_COOKIE);
export const hasSession = (c: Context): boolean => sessionValid(sessionOf(c));

/** Same-origin check for cookie-authenticated writes: Sec-Fetch-Site same-origin, else an Origin whose host equals Host. */
export function sameOrigin(c: Context): boolean {
  if (c.req.header("sec-fetch-site") === "same-origin") return true;
  const origin = c.req.header("origin"), host = c.req.header("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}
export const isWriteMethod = (m: string) => m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
/** The request came over https (directly or through a proxy that says so). */
export const overHttps = (c: Context) => c.req.header("x-forwarded-proto") === "https" || c.req.url.startsWith("https:");
