// Owner checks on the panel: list for the page, and the owner's tap (Works / Not yet). Panel auth; POSTs are root-only writes (mount.ts isPanelWrite
// covers the /agentnet-panel/ prefix). Resolving tells root with a message from "owner"; it never spawns or despawns anything: root decides.
import type { Hono } from "hono";
import { audit } from "../core/logger";
import { problem, type Env } from "../core/http";
import { body, bad, enqueueMessage, ADMIN, OWNER, resolveTo } from "./routes";
import { flush } from "./store";
import { listChecks, resolveCheck, type Check } from "./checks";

/** The report root gets when the owner resolves a check. */
export function resolveMessage(c: Check): { subject: string; body: string } {
  const head = `Owner answered "${c.answer}": ${c.question}`;
  const lines = [head, `agent: ${c.agent}${c.team ? ` (team ${c.team})` : ""}`, c.detail ? `how: ${c.detail}` : "", c.note ? `owner note: ${c.note}` : ""].filter(Boolean);
  return { subject: head.slice(0, 60), body: lines.join("\n") };
}

export function checksPanelRoutes(api: Hono<Env>) {
  api.get("/agentnet-panel/checks", (c) => {
    const st = c.req.query("state");
    return c.json({ checks: listChecks(st === "pending" || st === "answered" ? st : undefined) });
  });
  api.post("/agentnet-panel/checks/:id/resolve", async (c) => {
    const id = Number(c.req.param("id")), b = await body(c as never);
    const out = resolveCheck(id, b.option, b.note);
    if ("error" in out) return out.status === 422 ? bad(c, out.error) : problem(c, out.status, out.status === 404 ? "Not Found" : "Conflict", out.error);
    const m = resolveMessage(out.check), root = resolveTo("root");
    // A root that is gone or failed refuses mail: the answer still lands in the loopback root inbox (ADMIN), never dropped.
    let sent = root ? enqueueMessage(OWNER, root, m.body, "report", null, m.subject) : null;
    if (!sent || sent.state === "gone") sent = enqueueMessage(OWNER, ADMIN, m.body, "report", null, m.subject);
    flush();
    audit(c.get("actor"), "agentnet.check-resolve", out.check.agent, "ok", c.get("trace"), { check: id, result: out.check.state });
    return c.json({ check: out.check, message: sent?.id ?? null });
  });
}
