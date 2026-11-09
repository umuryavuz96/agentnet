// agentnet background agents and their Terminal.app windows (agents work in the background,
// a window opens only on request, never iTerm, no leftover windows). The window truth is tmux: an agent runs in its
// own detached session `agentnet-<name>`; "open" attaches a Terminal.app window to it, "close" detaches every client
// (the attach exits cleanly and Terminal closes the window by its profile), despawn kills the session. No Automation,
// no stored window ids: `tmux list-clients` says what is open. Every tmux target uses the exact form `=<session>`.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { ROOT } from "../core/config";
import { audit, logEvent } from "../core/logger";
import { problem, type Env } from "../core/http";
import { byName, NAME_RE } from "./routes";
import { onPatch } from "./store";

export const rootSession = () => process.env.AGENTNET_ROOT_SESSION ?? "agentnet-root";
export const sessionOf = (name: string) => (name === "root" ? rootSession() : `agentnet-${name}`);
export const isAgentSession = (s: string) => s.startsWith("agentnet-") && s !== rootSession();
/** The .command Terminal.app runs: attach, and when the attach ends (detach or session gone) close its own window. */
export const commandFile = (session: string) => `#!/bin/bash
# agentnet: opened by agentnet. Closing this window only detaches; the agent keeps running.
tmux attach -t '=${session}'
osascript -e 'tell application "Terminal" to close (first window whose tty of selected tab is "'"$(tty)"'")' >/dev/null 2>&1 &
exit 0
`;

export interface Tmux { run: (args: string[]) => { code: number; out: string } }
const tmuxBin = () => Bun.which("tmux");
export const realTmux: Tmux = { run: (args) => { const t = tmuxBin(); if (!t) return { code: 127, out: "" }; const p = Bun.spawnSync([t, ...args]); return { code: p.exitCode, out: new TextDecoder().decode(p.stdout) }; } };

export const hasSession = (s: string, t: Tmux = realTmux) => t.run(["has-session", "-t", `=${s}`]).code === 0;
/** Sessions that have at least one attached client (one `tmux list-clients`, so a 1 s sweep is cheap). */
export const attachedSessions = (t: Tmux = realTmux): Set<string> => new Set(t.run(["list-clients", "-F", "#{session_name}"]).out.split("\n").map((l) => l.trim()).filter(Boolean));
export const detach = (s: string, t: Tmux = realTmux) => t.run(["detach-client", "-s", `=${s}`]).code === 0;
/** When the session was created (tmux `session_created`), "" if there is none: tells two sessions of the same name apart. */
export const createdOf = (s: string, t: Tmux = realTmux) => { const r = t.run(["display-message", "-p", "-t", `=${s}:`, "#{session_created}"]); return r.code === 0 ? r.out.trim() : ""; };
/** Stop: one Escape to the agent's pane interrupts its current turn (a second would open Claude Code's rewind menu). */
export const interrupt = (s: string, t: Tmux = realTmux) => t.run(["send-keys", "-t", `=${s}:`, "Escape"]).code === 0;
export const killSession = (s: string, t: Tmux = realTmux) => t.run(["kill-session", "-t", `=${s}`]).code === 0;
export const agentSessions = (t: Tmux = realTmux) => t.run(["list-sessions", "-F", "#{session_name}"]).out.split("\n").map((l) => l.trim()).filter(isAgentSession);

export const DIR = () => join(ROOT, "run", "agentnet");
/** Open: raise Terminal when a client is already attached, else start one window on the session. */
export function openWindow(name: string, t: Tmux = realTmux, open: (args: string[]) => void = (a) => { Bun.spawn(["/usr/bin/open", ...a], { stdout: "ignore", stderr: "ignore" }); }): { ok: true; opened: boolean } | { ok: false; status: 404 | 422; detail: string } {
  if (!NAME_RE.test(name)) return { ok: false, status: 422, detail: "bad agent name" };
  const s = sessionOf(name);
  if (!hasSession(s, t)) return { ok: false, status: 404, detail: `no tmux session ${s}` };
  if (attachedSessions(t).has(s)) { open(["-a", "Terminal"]); return { ok: true, opened: false }; }
  if (!existsSync(DIR())) mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  const f = join(DIR(), `open-${name}.command`);
  writeFileSync(f, commandFile(s), { mode: 0o700 }); chmodSync(f, 0o700);
  open(["-a", "Terminal", f]);
  return { ok: true, opened: true };
}

/** A gone agent's detached session must not linger (its boot script drops into a shell after claude exits): kill it, exact
 *  name, a moment after the gone frame, and only if it is still the session that existed at the gone frame. Never a session that is not agentnet-<name> (root's own session stays). */
export function startSessionReaper(t: Tmux = realTmux, delayMs = 2000) {
  if (process.env.AGENTNET_SWEEP === "0") { logEvent("info", "agentnet: reaper off (AGENTNET_SWEEP=0)"); return; }
  return onPatch((ps) => { for (const p of ps) if (p.removed) { const s = sessionOf(p.snapshot.name); if (isAgentSession(s)) { const created = createdOf(s, t); setTimeout(() => { if (createdOf(s, t) === created) killSession(s, t); }, delayMs); } } });
}

export function agentnetWindowRoutes(api: Hono<Env>) { // panel auth (not the agent token): the page's Open / Close buttons
  api.post("/agentnet/agents/:name/open", (c) => {
    const name = String(c.req.param("name"));
    if (name !== "root" && !byName(name)) return problem(c, 404, "Not Found", "no live agent by that name");
    const r = openWindow(name);
    if (!r.ok) return problem(c, r.status, r.status === 404 ? "Not Found" : "Can't do that", r.detail);
    audit(c.get("actor"), "agentnet.open", name, "ok", c.get("trace"), { opened: r.opened });
    return c.json({ agent: name, session: sessionOf(name), opened: r.opened, raised: !r.opened });
  });
  api.post("/agentnet/agents/:name/close", (c) => {
    const name = String(c.req.param("name"));
    if (!NAME_RE.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    const s = sessionOf(name);
    if (!hasSession(s)) return problem(c, 404, "Not Found", `no tmux session ${s}`);
    detach(s);
    return c.json({ agent: name, closed: true });
  });
  api.post("/agentnet/windows/close-all", (c) => { // windows only: every agent keeps running
    const closed = agentSessions().filter((s) => attachedSessions().has(s)).map((s) => (detach(s), s));
    audit(c.get("actor"), "agentnet.close-all", String(closed.length), "ok", c.get("trace"));
    return c.json({ closed });
  });
}
