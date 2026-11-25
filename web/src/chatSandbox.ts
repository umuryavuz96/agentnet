// Live UI from an agent (docs/CHAT-UI-BLOCKS.md, "Live UI"): the pure parts of the sandbox. The frame itself is
// ChatSandbox.vue; the shell page it loads and that page's policy are in src/net/web.ts.
//
// The walls are the browser's, not this file's: the frame has `sandbox="allow-scripts"` without `allow-same-origin` (an
// opaque origin: no cookies, no storage, no way to the chat's DOM) and its page is served with `default-src 'none'` (no
// network). What this file decides is the one thing the frame can ask for: sending a line as the owner. A script in the
// frame can post any message it likes, so judgeSend only looks at facts the chat page measured itself.

/** The frame's height is its content's, up to this; past it the frame scrolls inside. */
export const HEIGHT_MAX = 720, HEIGHT_MIN = 40;
/** The longest line a frame may send as the owner. */
export const SEND_MAX = 2000;
/** How long the browser keeps a click "just happened" (transient activation). */
export const ACTIVATION_MS = 5000;
/** Every bridge message carries this mark, both ways. */
export const MARK = "agentnetSandbox";

export const clampHeight = (h: unknown): number => (typeof h === "number" && Number.isFinite(h) ? Math.max(HEIGHT_MIN, Math.min(HEIGHT_MAX, Math.ceil(h))) : HEIGHT_MIN);

/** A message from the frame, checked: null for anything that is not one of the three the bridge knows. */
export type FromFrame = { t: "ready" } | { t: "size"; h: number } | { t: "send"; text: string };
export function readMessage(data: unknown): FromFrame | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d[MARK] !== 1) return null;
  if (d.t === "ready") return { t: "ready" };
  if (d.t === "size" && typeof d.h === "number" && Number.isFinite(d.h)) return { t: "size", h: d.h };
  if (d.t === "send" && typeof d.text === "string") return { t: "send", text: d.text };
  return null;
}

/** What the chat page knows at the moment a frame asks to send. All of it is measured outside the frame. */
export interface SendFacts {
  text: string;
  /** the message came from this frame's own window */
  fromFrame: boolean;
  /** the browser says the user acted just now (navigator.userActivation.isActive); false where the browser cannot say */
  active: boolean;
  /** this frame is the focused element of the chat page: the click or key was inside it */
  focused: boolean;
  /** this frame already sent, or the owner answered after the reply */
  locked: boolean;
  /** the owner can type into the terminal right now */
  canSend: boolean;
  /** ms since the owner last clicked or typed in the chat page itself (not in a frame) */
  sinceOwnInput: number;
}
/** send: goes out as the owner's line. confirm: the chat shows the line with its own Send button (the owner acted in the
 *  chat page a moment ago, so "the user just acted" could be that and not a click in the frame). drop: ignored. */
export type Verdict = "send" | "confirm" | "drop";
export function judgeSend(f: SendFacts): Verdict {
  const text = f.text.trim();
  if (!f.fromFrame || f.locked || !f.canSend || !text || text.length > SEND_MAX) return "drop";
  if (!f.active || !f.focused) return "drop";
  return f.sinceOwnInput < ACTIVATION_MS ? "confirm" : "send";
}

/** The chat's tokens the frame gets as CSS variables. */
export const THEME_VARS = ["--bg", "--panel", "--ink", "--muted", "--line", "--accent", "--on-accent", "--agent", "--ok", "--warn", "--bad", "--font", "--mono", "--radius"] as const;
export type Theme = { mode: "dark" | "light"; vars: Record<string, string> };
const safeValue = (v: string) => v.replace(/[;{}<>]/g, "").slice(0, 200);
const rootVars = (t: Theme) => THEME_VARS.map((k) => (t.vars[k] ? `${k}:${safeValue(t.vars[k]!)};` : "")).join("");

// Runs inside the frame, before the agent's own markup. It owns nothing the agent's script could not do itself: it only
// saves writing the same postMessage calls in every block.
const BRIDGE = `(function(){var P=parent,M="${MARK}",root=document.documentElement;
function post(m){m[M]=1;P.postMessage(m,"*")}
var api={answered:null,theme:root.dataset.theme,send:function(t){post({t:"send",text:String(t)})}};
window.agentnet=api;
addEventListener("click",function(e){if(!e.isTrusted||api.answered!==null)return;var el=e.target&&e.target.closest?e.target.closest("[data-send]"):null;if(el&&!el.disabled)api.send(el.getAttribute("data-send")||el.textContent.trim())},true);
addEventListener("message",function(e){if(e.source!==P||!e.data||e.data[M]!==1)return;var d=e.data;
if(d.t==="theme"&&d.vars){for(var k in d.vars)root.style.setProperty(k,String(d.vars[k]));root.dataset.theme=api.theme=d.mode;dispatchEvent(new CustomEvent("agentnet:theme",{detail:d.mode}))}
if(d.t==="answered"){api.answered=String(d.text||"");root.dataset.answered="";var a=document.querySelectorAll("[data-send]");for(var i=0;i<a.length;i++){a[i].disabled=true;a[i].setAttribute("aria-disabled","true")}dispatchEvent(new CustomEvent("agentnet:answered",{detail:api.answered}))}});
var h=0;function size(){var n=Math.ceil(root.getBoundingClientRect().height);if(n!==h){h=n;post({t:"size",h:n})}}
if(window.ResizeObserver)new ResizeObserver(size).observe(root);addEventListener("load",size);document.addEventListener("DOMContentLoaded",size);
})();`;

// Bare HTML already looks like the chat: text, links, buttons, inputs and tables take the tokens.
const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
html{color-scheme:light dark;background:var(--bg);color:var(--ink);font:14px/1.5 var(--font);-webkit-text-size-adjust:100%}
html[data-theme="dark"]{color-scheme:dark}html[data-theme="light"]{color-scheme:light}
body{margin:0;padding:14px;overflow-wrap:anywhere}
h1,h2,h3,h4{margin:0 0 .4em;line-height:1.25;font-weight:650}h1{font-size:1.3em}h2{font-size:1.15em}h3,h4{font-size:1em}
p{margin:0 0 .7em}p:last-child{margin-bottom:0}small{color:var(--muted)}
a{color:var(--accent)}code,pre,kbd{font-family:var(--mono);font-size:.92em}
button,input,select,textarea{font:inherit;color:inherit}
button{min-height:34px;padding:0 13px;border:1px solid var(--line);border-radius:calc(var(--radius) - 2px);background:var(--panel);cursor:pointer}
button:hover{border-color:var(--muted)}button:active{transform:scale(.97)}
button[data-send]{border-color:var(--accent);background:var(--accent);color:var(--on-accent);font-weight:600}
button:disabled{opacity:.5;cursor:default;transform:none}
input,select,textarea{padding:6px 9px;border:1px solid var(--line);border-radius:calc(var(--radius) - 4px);background:var(--panel)}
input[type=range],input[type=checkbox],input[type=radio]{padding:0;accent-color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
table{border-collapse:collapse;width:100%}th,td{padding:6px 9px;border-bottom:1px solid var(--line);text-align:left}
hr{border:0;border-top:1px solid var(--line)}img,svg,canvas,video{max-width:100%}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;

/** The whole document the shell writes into the frame: tokens, base styles, the bridge, then the agent's markup as written. */
export function sandboxDoc(html: string, theme: Theme): string {
  return `<!doctype html><html lang="en" data-theme="${theme.mode === "light" ? "light" : "dark"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<style>:root{${rootVars(theme)}}\n${BASE_CSS}</style><script>${BRIDGE}</script></head><body>\n${html}\n</body></html>`;
}
