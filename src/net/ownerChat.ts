// Talk to an agent as the owner. GET /agentnet/agents/:name/feed = SSE of its terminal feed (see feed.ts);
// POST /agentnet/agents/:name/prompt {text, nonce?} types into its tmux pane (bracketed paste, then Enter).
// Panel auth; the POST is a panel write (mount.ts isPanelWrite). Nothing here ever touches a session that is not agentnet-<name> / the director's.
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { audit, logEvent } from "../core/logger";
import { problem, type Env } from "../core/http";
import { FEED_MAX, FeedParser, sent, transcriptFor, type FeedItem } from "./feed";
import { inTree, NAME_RE } from "./routes";
import { live } from "./store";
import { findRootSession, hasSession, realTmux, rootPid, sessionOf, type Tmux } from "./windows";

export const PROMPT_MAX = 8 * 1024;
export const NO_TERMINAL = "This agent runs in a terminal agentnet cannot type into.";
export const NO_TERMINAL_ROOT = "The director runs in a terminal agentnet cannot type into. Use Move director to run it in tmux.";

export interface ChatDeps { tmux: Tmux; sleep: (ms: number) => Promise<void>; ppid?: (p: number) => number | null; tickMs: number }
const defaults: ChatDeps = { tmux: realTmux, sleep: (ms) => Bun.sleep(ms), tickMs: 1000 };

/** The tmux target to type into: the agent's session (`=name:` = its active pane), or for the director the pane whose process tree holds its pid. Null = not in tmux. */
export function terminalOf(name: string, d: Pick<ChatDeps, "tmux" | "ppid">): string | null {
  if (name !== "root") { const s = sessionOf(name); return hasSession(s, d.tmux) ? `=${s}:` : null; }
  const pid = rootPid(), s = findRootSession(d.tmux, pid, d.ppid);
  if (!s || !hasSession(s, d.tmux)) return null;
  if (pid && pid > 1 && !s.startsWith("agentnet-")) { // the user's own tmux session: only the pane that holds the director
    const ppid = d.ppid ?? (() => null);
    for (const l of d.tmux.run(["list-panes", "-a", "-F", "#{session_name} #{pane_id} #{pane_pid}"]).out.split("\n")) {
      const [sn, pane, pp] = l.trim().split(" ");
      if (sn === s && pane && inTree(pid, [Number(pp)], ppid)) return pane;
    }
    return null;
  }
  return `=${s}:`;
}

/** Bracketed paste (newlines must not press Enter), then Enter. Returns an error sentence, or null when typed. */
export async function typeInto(target: string, text: string, d: Pick<ChatDeps, "tmux" | "sleep">): Promise<string | null> {
  const buf = `agentnet-prompt-${process.pid}`;
  if (d.tmux.run(["set-buffer", "-b", buf, "--", text]).code !== 0) return "tmux could not take the text";
  if (d.tmux.run(["paste-buffer", "-p", "-d", "-b", buf, "-t", target]).code !== 0) return "tmux could not paste into the terminal";
  await d.sleep(400); // Claude Code needs a moment to take the paste before Enter
  return d.tmux.run(["send-keys", "-t", target, "Enter"]).code === 0 ? null : "tmux could not press Enter";
}

export function ownerChatRoutes(api: Hono<Env>, deps: Partial<ChatDeps> = {}) {
  const d: ChatDeps = { ...defaults, ...deps };
  const rowOf = (name: string) => live().find((a) => a.name === name);

  api.post("/agentnet/agents/:name/prompt", async (c) => {
    const name = String(c.req.param("name"));
    if (!NAME_RE.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    const row = rowOf(name);
    if (name !== "root" && !row) return problem(c, 404, "Not Found", "no live agent by that name");
    if (row && (row.life === "gone" || row.life === "failed") && name !== "root") return problem(c, 410, "Gone", `${name} is gone`);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const text = typeof b.text === "string" ? b.text.replace(/\r\n?/g, "\n").trim() : "";
    if (!text) return problem(c, 422, "Can't do that", "text is empty");
    if (Buffer.byteLength(text) > PROMPT_MAX) return problem(c, 422, "Can't do that", "text over 8 kB");
    const nonce = typeof b.nonce === "string" && /^[\w-]{1,64}$/.test(b.nonce) ? b.nonce : null;
    const target = terminalOf(name, d);
    if (!target) return problem(c, 409, "Can't do that", name === "root" ? NO_TERMINAL_ROOT : NO_TERMINAL, { code: "NO_TERMINAL" });
    sent.add(name, text, nonce);
    const err = await typeInto(target, text, d);
    audit(c.get("actor"), "agentnet.owner-prompt", name, err ? "failed" : "ok", c.get("trace"), { length: text.length }); // length only, never the text
    if (err) return problem(c, 502, "Bad Gateway", err);
    logEvent("info", "agentnet: owner prompt", { agent: name, length: text.length });
    return c.json({ agent: name, sent: true, nonce });
  });

  // First `reset` (the last 200 items), then `items` with only what changed. The file is polled while a client listens.
  api.get("/agentnet/agents/:name/feed", (c) => {
    const name = String(c.req.param("name"));
    if (!NAME_RE.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    return streamSSE(c, async (stream) => {
      let path: string | null = null, p: FeedParser | null = null, cursor = 0, beat = Date.now(), pending = "";
      const pend = () => sent.pending(name).filter((e) => e.nonce).map((e) => ({ id: `sending:${e.nonce}`, kind: "owner", ts: e.at, text: e.text, nonce: e.nonce!, sending: true }) as FeedItem);
      while (!stream.aborted) {
        const r = rowOf(name), before: string | null = path;
        path = r || name === "root" ? transcriptFor({ session: r?.session ?? null, project: r?.project ?? null, pid: r?.pid ?? null }) : null;
        if (path !== before || (!p && path)) {
          p = path ? new FeedParser(path, name) : null; p?.update(); cursor = p?.cursor ?? 0;
          pending = JSON.stringify(pend());
          await stream.writeSSE({ event: "reset", data: JSON.stringify({ items: p ? p.recent(FEED_MAX) : [], pending: JSON.parse(pending) }) });
        } else if (p) {
          p.update();
          const ch = p.changedSince(cursor); cursor = ch.cursor;
          if (ch.items.length) await stream.writeSSE({ event: "items", data: JSON.stringify(ch.items) });
          const pn = JSON.stringify(pend());
          if (pn !== pending) { pending = pn; await stream.writeSSE({ event: "pending", data: pn }); }
        }
        if (Date.now() - beat > 15_000) { beat = Date.now(); await stream.writeSSE({ event: "ping", data: "" }); }
        await stream.sleep(d.tickMs);
      }
    });
  });
}
