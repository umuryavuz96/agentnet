// Step 3: Claude accounts that spawned agents log in with (docs/internal/one-folder/SPEC-step3-config-dir.md).
// $AGENTNET_HOME/accounts/<id>/ (0700) holds one secret file (0600): `oauth-token`, from `claude setup-token`. agentnet runs on the
// Claude Code subscription only, so there is no API-key kind (test/hook-scripts.test.ts "no API key anywhere").
// The secret is written once and never read back by the server: lists, logs and errors name the account, never its value.
// The boot script reads it with $(cat <file>) so it never lands in a boot file or a process list.
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { rootOnly } from "../core/access";
import { ROOT } from "../core/config";
import { db } from "../core/db";
import { problem, type Env } from "../core/http";
import { logEvent } from "../core/logger";
import { assertInHome } from "../core/paths";
import { live } from "./store";

export const ACCOUNT_ID = /^[a-z0-9-]{1,32}$/;
export const DEFAULT_ACCOUNT = "main";
export type AccountKind = "oauth";
const FILES: Record<AccountKind, string> = { oauth: "oauth-token" };
/** The env var Claude Code reads the secret from. */
export const ACCOUNT_ENV: Record<AccountKind, string> = { oauth: "CLAUDE_CODE_OAUTH_TOKEN" };

export const accountsDir = () => join(ROOT, "accounts");
/** The secret file of an account, or null when there is none (an unknown or malformed id is null too). */
export function accountFile(id: string | null | undefined): { kind: AccountKind; file: string } | null {
  const a = id || DEFAULT_ACCOUNT;
  if (!ACCOUNT_ID.test(a)) return null;
  for (const kind of ["oauth"] as const) { const file = join(accountsDir(), a, FILES[kind]); if (existsSync(file)) return { kind, file }; }
  return null;
}

/** Live agents (not root) whose spawn named this account. */
export function agentsOn(id: string): string[] {
  const names = new Set(live().map((s) => s.name));
  return (db().query("SELECT name, account FROM agents WHERE archived_at IS NULL").all() as { name: string; account: string | null }[])
    .filter((r) => (r.account || DEFAULT_ACCOUNT) === id && names.has(r.name)).map((r) => r.name);
}

export interface AccountInfo { id: string; kind: AccountKind; added: number; agents: number }
export function listAccounts(): AccountInfo[] {
  let ids: string[] = []; try { ids = readdirSync(accountsDir()).filter((n) => ACCOUNT_ID.test(n)).sort(); } catch { return []; }
  return ids.flatMap((id) => { const f = accountFile(id); return f ? [{ id, kind: f.kind, added: Math.round(statSync(f.file).mtimeMs), agents: agentsOn(id).length }] : []; });
}

export class AccountError extends Error { constructor(msg: string, readonly status: 404 | 409 | 422) { super(msg); } }
/** Store a token: trimmed, no whitespace inside, at most 4096 chars. Replaces the account's earlier token. */
export function addAccount(id: unknown, v: { token?: unknown; apiKey?: unknown }): AccountInfo {
  if (typeof id !== "string" || !ACCOUNT_ID.test(id)) throw new AccountError("id must be 1-32 lowercase letters, digits or dashes", 422);
  if (v.apiKey !== undefined && v.apiKey !== null) throw new AccountError("API keys are not supported: agentnet runs on the Claude Code subscription; give the token from `claude setup-token`", 422);
  const kind: AccountKind = "oauth", val = typeof v.token === "string" ? v.token.trim() : "";
  if (!val) throw new AccountError("token is empty", 422);
  if (/\s/.test(val)) throw new AccountError("token has whitespace inside", 422);
  if (val.length > 4096) throw new AccountError("token is longer than 4096 characters", 422);
  const d = join(accountsDir(), id), file = join(d, FILES[kind]);
  assertInHome(file, "account secret");
  mkdirSync(accountsDir(), { recursive: true, mode: 0o700 }); chmodSync(accountsDir(), 0o700);
  mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700);
  const tmp = join(d, `.${FILES[kind]}.tmp`);
  writeFileSync(tmp, val + "\n", { mode: 0o600 }); chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  logEvent("info", "account added", { id, kind });
  return { id, kind, added: Math.round(statSync(file).mtimeMs), agents: agentsOn(id).length };
}
/** Remove an account. Refused while a live agent uses it. */
export function removeAccount(id: string): void {
  if (!ACCOUNT_ID.test(id) || !existsSync(join(accountsDir(), id))) throw new AccountError(`no account ${id}`, 404);
  const on = agentsOn(id);
  if (on.length) throw new AccountError(`account ${id} is in use by ${on.join(", ")}; despawn them first`, 409);
  rmSync(join(accountsDir(), id), { recursive: true, force: true });
  logEvent("info", "account removed", { id });
}

export function accountRoutes(api: Hono<Env>) {
  const fail = (c: Context<Env>, e: unknown) => {
    if (e instanceof AccountError) return problem(c, e.status, e.status === 404 ? "Not Found" : e.status === 409 ? "Conflict" : "Can't do that", e.message);
    logEvent("warn", "account write failed", { error: (e as Error).name }); // the message may carry a path, never the secret; keep it out anyway
    return problem(c, 500, "Internal Server Error", "could not store the account");
  };
  api.get("/accounts", rootOnly, (c) => c.json({ accounts: listAccounts() }));
  api.post("/accounts", rootOnly, async (c) => {
    let b: Record<string, unknown> = {}; try { const j = await c.req.json(); if (j && typeof j === "object") b = j as Record<string, unknown>; } catch { /* empty */ }
    try { return c.json(addAccount(b.id, { token: b.token, apiKey: b.apiKey }), 201); } catch (e) { return fail(c, e); }
  });
  api.delete("/accounts/:id", rootOnly, (c) => { try { removeAccount(c.req.param("id")); return c.json({ removed: c.req.param("id") }); } catch (e) { return fail(c, e); } });
}
