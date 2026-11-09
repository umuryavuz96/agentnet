// Fake agentnet server for CLI/script tests: Bun.serve on 127.0.0.1:0, records every call.
export type Handler = (req: Request, body: unknown) => Response | Promise<Response>;
export interface Call { method: string; path: string; headers: Record<string, string>; body: unknown }

export function fakeServer(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const text = await req.text();
      let body: unknown = text;
      try { body = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
      calls.push({ method: req.method, path, headers: Object.fromEntries(req.headers), body });
      const h = routes[`${req.method} ${path}`];
      return h ? h(req, body) : new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

export const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
