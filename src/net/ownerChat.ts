// Talk to an agent as the owner. GET /agentnet/agents/:name/feed = SSE of its terminal feed (see feed.ts);
// POST /agentnet/agents/:name/prompt {text, nonce?} types into its tmux pane (bracketed paste, then Enter). It answers after the paste;
// the Enter follows ENTER_WAIT later, off the request.
// GET /agentnet/agents/:name/history?before=<item id>&n=<1..200> = the feed items before that one (the stream only carries the
// newest; the page asks for older ones when the owner scrolls up). The whole transcript is read for it, once, and kept a while.
// Panel auth; the POST is a panel write (mount.ts isPanelWrite). Nothing here ever touches a session that is not agentnet-<name> / the director's.
import { statSync, watch, type FSWatcher } from "node:fs";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { audit, logEvent } from "../core/logger";
import { problem, type Env } from "../core/http";
import { FEED_MAX, FeedParser, sent, transcriptFor, type FeedItem } from "./feed";
import { inTree, NAME_RE } from "./routes";
import { live } from "./store";
import { ownerPush, viaPlugin } from "./ownerPlugin";
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

/** Bracketed paste (newlines must not press Enter). Returns an error sentence, or null when the text is in the terminal's input. */
export function pasteInto(target: string, text: string, d: Pick<ChatDeps, "tmux">): string | null {
  const buf = `agentnet-prompt-${process.pid}`;
  if (d.tmux.run(["set-buffer", "-b", buf, "--", text]).code !== 0) return "tmux could not take the text";
  return d.tmux.run(["paste-buffer", "-p", "-d", "-b", buf, "-t", target]).code === 0 ? null : "tmux could not paste into the terminal";
}
export const ENTER_WAIT = 20; // a short gap after the paste; 0 and 20 ms both submitted 2-line and 6 kB pastes whole (was 400)
/** Paste, wait, Enter. Returns an error sentence, or null when typed. */
export async function typeInto(target: string, text: string, d: Pick<ChatDeps, "tmux" | "sleep">): Promise<string | null> {
  const err = pasteInto(target, text, d);
  if (err) return err;
  await d.sleep(ENTER_WAIT);
  return d.tmux.run(["send-keys", "-t", target, "Enter"]).code === 0 ? null : "tmux could not press Enter";
}

// One prompt at a time per agent: the next paste must not land before the Enter of the one before it.
const tails = new Map<string, Promise<void>>();
/** Resolves when every prompt sent to this agent so far has had its Enter (tests, shutdown). */
export const settled = (name: string): Promise<void> => tails.get(name) ?? Promise.resolve();

/** After Send now's Escape: time for Claude Code to end the turn and take the queued text before the input box is read. */
export const SEND_NOW_SETTLE = 800;
const nowing = new Set<string>();
/** Does the input box at the bottom of a Claude Code pane hold this text (typed out, or folded as "[Pasted text …]")?
 *  The box is the last `❯` line between the two bottom rules. An empty box, or its "Press up…" hint, is no. */
export function inputHolds(pane: string, text: string): boolean {
  const lines = pane.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const rules = lines.map((l, i) => (/^─{8,}/.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
  if (rules.length < 2) return false;
  const [a, b] = rules.slice(-2) as [number, number];
  const box = lines.slice(a + 1, b).join(" ").replace(/^\s*❯\s?/, "").replace(/\s+/g, " ").trim();
  if (!box || /^Press up to edit queued/.test(box)) return false;
  if (/^\[Pasted text #\d+/.test(box)) return true;
  const head = text.replace(/\s+/g, " ").trim().slice(0, 40);
  return head.length > 0 && box.startsWith(head.slice(0, Math.min(head.length, box.length)));
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
    if (name !== "root" && viaPlugin(name, b.via, undefined, !!row?.turn)) { // idle + capable plugin (ownerPlugin.ts; AGENTNET_OWNER_VIA_PLUGIN=0 = off): the plugin submits it, no tmux. Mid-turn it is typed below
      sent.drop(name, nonce); sent.add(name, text, nonce);
      ownerPush(name, { nonce, text, at: Date.now() });
      audit(c.get("actor"), "agentnet.owner-prompt", name, "ok", c.get("trace"), { length: text.length, via: "plugin" });
      return c.json({ agent: name, sent: true, nonce, via: "plugin" });
    }
    const target = terminalOf(name, d);
    if (!target) return problem(c, 409, "Can't do that", name === "root" ? NO_TERMINAL_ROOT : NO_TERMINAL, { code: "NO_TERMINAL" });
    // The answer goes out as soon as the text is pasted; the wait and the Enter run after it, so the page never waits on them.
    // A refused Enter marks the send failed in the feed (`pending` with failed: true) and the page offers a retry.
    const before = settled(name);
    let release!: () => void;
    tails.set(name, new Promise<void>((r) => { release = r; }));
    await before;
    sent.drop(name, nonce); // a retry of the same nonce
    sent.add(name, text, nonce);
    const err = pasteInto(target, text, d);
    if (err) {
      release(); sent.drop(name, nonce);
      audit(c.get("actor"), "agentnet.owner-prompt", name, "failed", c.get("trace"), { length: text.length }); // length only, never the text
      return problem(c, 502, "Bad Gateway", err);
    }
    const actor = c.get("actor"), trace = c.get("trace");
    void (async () => {
      try {
        await d.sleep(ENTER_WAIT);
        const ok = d.tmux.run(["send-keys", "-t", target, "Enter"]).code === 0;
        if (!ok) sent.fail(name, nonce);
        audit(actor, "agentnet.owner-prompt", name, ok ? "ok" : "failed", trace, { length: text.length });
        if (ok) logEvent("info", "agentnet: owner prompt", { agent: name, length: text.length });
      } finally { release(); }
    })();
    return c.json({ agent: name, sent: true, nonce });
  });

  // Send now: the owner's prompt waits in Claude Code's queue while the agent works. One Escape (the Stop key) ends the turn,
  // and Claude Code then submits the queued text by itself, once (measured: interrupt and the queued line 20 ms apart).
  // So this never types the text again. Only when the text sits in the input box instead of the queue does it press Enter.
  api.post("/agentnet/agents/:name/send-now", async (c) => {
    const name = String(c.req.param("name"));
    if (!NAME_RE.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    if (name === "root") return problem(c, 403, "Forbidden", "root cannot be stopped from the panel");
    const row = rowOf(name);
    if (!row || row.life === "gone" || row.life === "failed") return problem(c, 404, "Not Found", "no live agent by that name");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const nonce = typeof b.nonce === "string" && /^[\w-]{1,64}$/.test(b.nonce) ? b.nonce : null;
    if (!nonce) return problem(c, 422, "Can't do that", "nonce is missing");
    const e = sent.pending(name).find((x) => x.nonce === nonce);
    if (!e || e.failed) return problem(c, 409, "Already taken", "the agent has this message already", { code: "TAKEN" });
    const target = terminalOf(name, d);
    if (!target) return problem(c, 409, "Can't do that", NO_TERMINAL, { code: "NO_TERMINAL" });
    if (nowing.has(name)) return c.json({ agent: name, nonce, interrupted: false, already: true }); // a second Escape opens the rewind menu
    nowing.add(name);
    try {
      await settled(name); // the prompt's own Enter is in before the Escape
      if (!sent.pending(name).some((x) => x.nonce === nonce)) return problem(c, 409, "Already taken", "the agent has this message already", { code: "TAKEN" });
      const working = row.state === "working";
      if (working && d.tmux.run(["send-keys", "-t", target, "Escape"]).code !== 0) return problem(c, 502, "Bad Gateway", "tmux refused the keys");
      await d.sleep(working ? SEND_NOW_SETTLE : 0);
      const entered = inputHolds(d.tmux.run(["capture-pane", "-p", "-t", target]).out, e.text) && d.tmux.run(["send-keys", "-t", target, "Enter"]).code === 0;
      audit(c.get("actor"), "agentnet.send-now", name, "ok", c.get("trace"), { interrupted: working, entered });
      return c.json({ agent: name, nonce, interrupted: working, entered });
    } finally { nowing.delete(name); }
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
      const pend = () => sent.pending(name).filter((e) => e.nonce).map((e) => ({ id: `sending:${e.nonce}`, kind: "owner", ts: e.at, text: e.text, nonce: e.nonce!, sending: !e.failed, ...(e.failed ? { failed: true } : {}) }) as FeedItem);
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

