export const LOOP = { requestIP: () => ({ address: "127.0.0.1" }) };
export const LAN = { requestIP: () => ({ address: "10.0.0.10" }) };
/** run/root.token of the test home (the server writes it in buildApp; ensureSecrets() makes it for apps built without buildApp). */
export async function rootToken(): Promise<string> {
  const { ensureSecrets } = await import("../src/core/auth");
  ensureSecrets();
  const { join } = await import("node:path"), { ROOT } = await import("../src/core/config"); // the home the server uses (fixed at first import), not today's env
  return (await Bun.file(join(ROOT, "run", "root.token")).text()).trim();
}
/** Adds `Authorization: Bearer <root.token>` to every request that carries no authorization header of its own. */
export async function asRoot<T extends { request: (input: string, init?: RequestInit, env?: unknown) => Response | Promise<Response> }>(app: T): Promise<T> {
  const t = await rootToken(), req = app.request.bind(app);
  app.request = ((input: string, init: RequestInit = {}, env?: unknown) => {
    const h = new Headers(init.headers);
    if (!h.has("authorization")) h.set("authorization", `Bearer ${t}`);
    return req(input, { ...init, headers: h }, env);
  }) as T["request"];
  return app;
}
/** Same for a makeFetch handler. */
export async function fetchAsRoot(f: (req: Request, server?: unknown) => Response | Promise<Response>) {
  const t = await rootToken();
  return (req: Request, server?: unknown) => {
    if (!req.headers.has("authorization")) { const h = new Headers(req.headers); h.set("authorization", `Bearer ${t}`); req = new Request(req, { headers: h }); }
    return f(req, server);
  };
}
