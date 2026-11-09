import { parseHash, toHash } from "./router";

export interface Embed { embed: boolean; theme: "light" | "dark" | null }

/** From location.search: embed=1 → true; theme=light|dark else null. Anything else is ignored. */
export function readEmbed(search: string): Embed {
  const p = new URLSearchParams(search), t = p.get("theme");
  return { embed: p.get("embed") === "1", theme: t === "light" || t === "dark" ? t : null };
}

let last = "";
/** Remember a hash the host set or we posted, so postRoute does not echo it back. */
export function noteRoute(hash: string) { last = hash; }

/** Embed mode only: tell the host the route changed. targetOrigin is our own origin, never "*". No-op without a parent frame. */
export function postRoute(hash: string): void {
  if (typeof window === "undefined" || window.parent === window || hash === last) return;
  last = hash;
  window.parent.postMessage({ type: "agentnet:route", hash }, location.origin);
}

/** On every hashchange: a non-canonical hash (the host sent the alias "#/teams?team=x") would come back normalized as
 *  "#/agents?team=x", a string the host never sent. Remember the normalized form so it is not posted back.
 *  A canonical hash is left alone: an in-frame click looks the same as a host-set hash, and the click must reach the host. */
export function noteHostHash(raw: string): void {
  const norm = toHash(parseHash(raw));
  if (norm !== raw) last = norm;
}
