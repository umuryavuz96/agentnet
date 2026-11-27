// Talk to an agent as the owner. GET /agentnet/agents/:name/feed = SSE of its terminal feed (see feed.ts);
// POST /agentnet/agents/:name/prompt {text, nonce?} queues the text for the agent's agentnet plugin (ownerPlugin.ts). Nothing is
// typed into a terminal. `waiting` in the answer = the plugin is not connected; the text goes out when it connects.
// GET /agentnet/agents/:name/history?before=<item id>&n=<1..200> = the feed items before that one (the stream only carries the
// newest; the page asks for older ones when the owner scrolls up). The whole transcript is read for it, once, and kept a while.
// Panel auth; the POST is a panel write (mount.ts isPanelWrite). Nothing here ever touches a session that is not agentnet-<name> / the director's.
import { statSync, watch, type FSWatcher } from "node:fs";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { audit } from "../core/logger";
import { problem, type Env } from "../core/http";
import { FEED_MAX, FeedParser, sent, transcriptFor, type FeedItem } from "./feed";
import { ADMIN, inTree, NAME_RE } from "./routes";
import { all, live } from "./store";
import { cutLately, cutTurn, ownerCapable, ownerPush } from "./ownerPlugin";
import { findRootSession, hasSession, realTmux, rootPid, sessionOf, type Tmux } from "./windows";

export const PROMPT_MAX = 8 * 1024;
export const NO_ABORT = "This agent's plugin cannot stop the turn. The message goes when the turn ends.";
export const NO_PLUGIN = "Waiting: this agent's agentnet plugin is not connected. It gets the message as soon as it connects.";

export interface ChatDeps { tmux: Tmux; sleep: (ms: number) => Promise<void>; ppid?: (p: number) => number | null; tickMs: number }
const defaults: ChatDeps = { tmux: realTmux, sleep: (ms) => Bun.sleep(ms), tickMs: 1000 };

/** The tmux target for chatRefs: the agent's session (`=name:` = its active pane), or for the director the pane whose process tree holds its pid. Null = not in tmux. */
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
    // The agentnet plugin is the only way in (the owner's rule, 2026-11-26): no tmux typing, no Move director. The plugin takes
    // the text and Claude Code submits it when the agent's turn ends; without a connected plugin it stays queued, and the answer says so.
    sent.drop(name, nonce); sent.add(name, text, nonce); // a retry of the same nonce replaces the entry
    ownerPush(name, { nonce, text, at: Date.now() });
    // A director that went away still counts as able (its hello is remembered): its card says it is gone. A root.token director has no card.
    const connected = ownerCapable(name) && (!!row || !all().some((a) => a.name === name));
    audit(c.get("actor"), "agentnet.owner-prompt", name, "ok", c.get("trace"), { length: text.length, connected }); // length only, never the text
    return c.json({ agent: name, sent: true, nonce, via: "plugin", ...(connected ? {} : { waiting: NO_PLUGIN }) });
  });

  // Send now: the owner's prompts wait in Claude Code's queue while the agent works. The plugin ends the turn and Claude Code
  // runs all of them. Nothing is pressed: an Escape drops queued plugin prompts (ownerPlugin.ts).
  api.post("/agentnet/agents/:name/send-now", async (c) => {
    const name = String(c.req.param("name"));
    if (!NAME_RE.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    const row = rowOf(name);
    if (name !== "root" && (!row || row.life === "gone" || row.life === "failed")) return problem(c, 404, "Not Found", "no live agent by that name");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const nonce = typeof b.nonce === "string" && /^[\w-]{1,64}$/.test(b.nonce) ? b.nonce : null;
    if (!nonce) return problem(c, 422, "Can't do that", "nonce is missing");
    if (!sent.pending(name).some((x) => x.nonce === nonce && !x.failed)) return problem(c, 409, "Already taken", "the agent has this message already", { code: "TAKEN" });
    if (row?.state === "idle") return c.json({ agent: name, nonce, interrupted: false }); // no turn to end: the message is going in
    if (cutLately(name)) return c.json({ agent: name, nonce, interrupted: false, already: true });
    if (!cutTurn(name, row?.id ?? ADMIN.id, row?.turn?.id ?? "")) return problem(c, 409, "Can't do that", NO_ABORT, { code: "NO_ABORT" });
    audit(c.get("actor"), "agentnet.send-now", name, "ok", c.get("trace"));
    return c.json({ agent: name, nonce, interrupted: true });
  });

  // Older items than the stream's window. A transcript can be close to a gigabyte, so the route never parses it whole: it reads
  // the last HIST_WIN bytes and widens the window (x4) only while the asked item is not far enough in. The parsers stay in a
  // small cache per transcript and are topped up from where they stopped, never re-read from scratch.
  const hists = new Map<string, { p: FeedParser; at: number }>();
  api.get("/agentnet/agents/:name/history", (c) => {
    const name = String(c.req.param("name"));
    if (!NAME_RE.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    const r = rowOf(name), before = c.req.query("before") ?? "", n = Math.min(FEED_MAX, Math.max(1, Number(c.req.query("n")) || 100));
    const path = r || name === "root" ? transcriptFor({ session: r?.session ?? null, project: r?.project ?? null, pid: r?.pid ?? null, name }) : null;
    if (!path) return c.json({ items: [], more: false });
    return c.json(historyPage(hists, path, name, before, n));
  });

  // First `reset` (the last 200 items), then `items` with only what changed. The transcript is watched (fs.watch), so a new
  // line goes out as soon as it is written; the tickMs loop stays as the fallback (pending sends, a moved transcript, a missed event).
  api.get("/agentnet/agents/:name/feed", (c) => {
    const name = String(c.req.param("name"));
    if (!NAME_RE.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    return streamSSE(c, async (stream) => {
      let path: string | null = null, p: FeedParser | null = null, cursor = 0, beat = Date.now(), pending = "";
      let watcher: FSWatcher | null = null, watched: string | null = null, dirty = false, wake: (() => void) | null = null;
      const poke = () => { dirty = true; wake?.(); };
      const unwatch = () => { try { watcher?.close(); } catch { /* closed */ } watcher = null; watched = null; };
      stream.onAbort(() => { unwatch(); wake?.(); });
      // Sleep until the file changes or tickMs passes. A change during the work before it wakes the next nap at once.
      const nap = () => new Promise<void>((res) => {
        if (dirty) { dirty = false; return res(); }
        const t = setTimeout(done, d.tickMs);
        function done() { clearTimeout(t); wake = null; dirty = false; res(); }
        wake = done;
      });
      const pend = () => sent.pending(name).filter((e) => e.nonce).map((e) => ({ id: `sending:${e.nonce}`, kind: "owner", ts: e.at, text: e.text, nonce: e.nonce!, ...(e.failed ? { failed: true } : { sending: true }) }) as FeedItem);
      while (!stream.aborted) {
        const r = rowOf(name), before: string | null = path;
        path = r || name === "root" ? transcriptFor({ session: r?.session ?? null, project: r?.project ?? null, pid: r?.pid ?? null, name }) : null;
        if (path !== watched) { unwatch(); if (path) { try { watcher = watch(path, poke); watched = path; } catch { /* not there yet: the tick finds it */ } } }
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
        await nap();
      }
      unwatch();
    });
  });
}

const HIST_WIN = 4_000_000, HIST_KEEP = 4, HIST_IDLE = 15 * 60_000;
/** The `n` items before `before` in a transcript, read through a cached window parser (see the history route). */
export function historyPage(cache: Map<string, { p: FeedParser; at: number }>, path: string, agent: string, before: string, n: number, win = HIST_WIN): { items: FeedItem[]; more: boolean } {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > HIST_IDLE) cache.delete(k);
  let h = cache.get(path);
  if (h) h.p.update();
  for (let w = Math.max(win, h ? statSizeOf(path) - h.p.start : 0); ; w *= 4) {
    if (!h) { h = { p: new FeedParser(path, agent, (a, _t, _ts, id) => (id ? sent.seen(a, id) : null), w, Infinity), at: now }; h.p.update(); }
    const all = h.p.items, i = all.findIndex((it) => it.id === before), whole = h.p.start === 0;
    if (i >= n || whole) {
      cache.delete(path); cache.set(path, { p: h.p, at: now });
      while (cache.size > HIST_KEEP) cache.delete(cache.keys().next().value!);
      if (i < 0) return { items: [], more: false };
      return { items: all.slice(Math.max(0, i - n), i), more: i - n > 0 || !whole };
    }
    h = undefined;
  }
}
const statSizeOf = (p: string) => { try { return statSync(p).size; } catch { return 0; } };

