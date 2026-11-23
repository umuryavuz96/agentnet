// Step 3: the accounts store (accounts/<id>/oauth-token; API keys are refused). The secret is written 0600 and never comes back:
// not in a list, a response body, an error body or a log line.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOP } from "./helpers";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-acct-"));
const { buildApp, makeFetch } = await import("../src/server");
{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../src/core/db"); useDatabase(new Database(":memory:")); (await import("../src/net/store"))._reset(); }
const { ROOT } = await import("../src/core/config");
const rt = await import("../src/net/routes");
const f = makeFetch(buildApp());
const ROOT_T = await (await import("./helpers")).rootToken();
const call = async (method: string, path: string, token: string, body?: unknown) => {
  const r = await f(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }), LOOP);
  return { status: r.status, text: await r.text() };
};
const SECRET = "sk-ant-oat01-TESTSECRET-" + "x".repeat(40), KEY = "sk-ant-api03-TESTKEY-" + "y".repeat(30);
const everything = (out: string[]) => {
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n), s = statSync(p); if (s.isDirectory()) walk(p); else files.push(p); } };
  if (existsSync(join(ROOT, "logs"))) walk(join(ROOT, "logs"));
  return [...out, ...files.map((p) => readFileSync(p, "utf8"))].join("\n");
};

test("accounts: add, list and delete; 0600 file in a 0700 dir; the secret never comes back", async () => {
  const seen: string[] = [];
  const add = await call("POST", "/api/v1/accounts", ROOT_T, { id: "main", token: `  ${SECRET}\n` }); seen.push(add.text);
  expect(add.status).toBe(201);
  expect(JSON.parse(add.text)).toMatchObject({ id: "main", kind: "oauth", agents: 0 });
  const file = join(ROOT, "accounts", "main", "oauth-token");
  expect(readFileSync(file, "utf8").trim()).toBe(SECRET); // trimmed
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(ROOT, "accounts", "main")).mode & 0o777).toBe(0o700);
  expect(statSync(join(ROOT, "accounts")).mode & 0o777).toBe(0o700);
  const k = await call("POST", "/api/v1/accounts", ROOT_T, { id: "ci-key", apiKey: KEY }); seen.push(k.text);
  expect(k.status).toBe(422); expect(k.text).toContain("setup-token"); // subscription only: no API-key accounts
  expect(existsSync(join(ROOT, "accounts", "ci-key"))).toBe(false);
  const two = await call("POST", "/api/v1/accounts", ROOT_T, { id: "ci-key", token: SECRET + "2" }); seen.push(two.text);
  expect(two.status).toBe(201);
  const list = await call("GET", "/api/v1/accounts", ROOT_T); seen.push(list.text);
  expect(JSON.parse(list.text).accounts.map((a: { id: string; kind: string }) => [a.id, a.kind])).toEqual([["ci-key", "oauth"], ["main", "oauth"]]);
  // bad input: errors name the problem, never the value
  for (const b of [{ id: "main", token: "" }, { id: "main", token: "abc def" }, { id: "main", token: "a".repeat(4097) }, { id: "Bad_Id", token: SECRET }, { id: "main", token: SECRET, apiKey: KEY }, { id: "main" }, { id: "main", token: `${SECRET} ${SECRET}` }]) {
    const r = await call("POST", "/api/v1/accounts", ROOT_T, b); seen.push(r.text);
    expect(r.status).toBe(422);
  }
  expect(readFileSync(file, "utf8").trim()).toBe(SECRET); // a refused write changes nothing
  const del = await call("DELETE", "/api/v1/accounts/ci-key", ROOT_T); seen.push(del.text);
  expect(del.status).toBe(200); expect(existsSync(join(ROOT, "accounts", "ci-key"))).toBe(false);
  expect((await call("DELETE", "/api/v1/accounts/ci-key", ROOT_T)).status).toBe(404);
  const all = everything(seen);
  expect(all).not.toContain(SECRET); expect(all).not.toContain(KEY);
  expect(all).not.toContain("TESTSECRET"); expect(all).not.toContain("TESTKEY");
});

test("accounts: delete is refused while a live agent uses it; an agent token gets 403", async () => {
  await call("POST", "/api/v1/accounts", ROOT_T, { id: "team", token: SECRET });
  const a = rt.createAgent({ name: "acct-user-1", boss: "root", job: "t", goal: "g", by: "test", account: "team" });
  const r = await call("DELETE", "/api/v1/accounts/team", ROOT_T);
  expect(r.status).toBe(409); expect(r.text).toContain("acct-user-1"); expect(r.text).not.toContain("TESTSECRET");
  expect(JSON.parse((await call("GET", "/api/v1/accounts", ROOT_T)).text).accounts.find((x: { id: string }) => x.id === "team").agents).toBe(1);
  for (const [m, p, b] of [["GET", "/api/v1/accounts", undefined], ["POST", "/api/v1/accounts", { id: "evil", token: "t0k" }], ["DELETE", "/api/v1/accounts/team", undefined]] as const)
    expect((await call(m, p, a.token, b)).status).toBe(403);
  expect(existsSync(join(ROOT, "accounts", "evil"))).toBe(false);
  rt.retireAgent(rt.byName("acct-user-1")!, "despawn", Date.now(), () => {});
  expect((await call("DELETE", "/api/v1/accounts/team", ROOT_T)).status).toBe(200);
});
