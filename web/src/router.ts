import { ref } from "vue";

export const PAGES = ["agents", "usage", "scores", "trails", "search", "hooks", "routing", "personas", "settings"] as const;
export type Page = (typeof PAGES)[number];
export interface Route { page: Page; query: Record<string, string> }

/** "#/scores?x=1" → { page: "scores", query: { x: "1" } }. "", "#", "#/", an unknown page or a malformed hash → agents, {}.
 *  Alias: "#/teams?team=t" → { page: "agents", query: { team: "t" } }. */
export function parseHash(hash: string): Route {
  const m = /^#\/([a-z]+)(?:\?(.*))?$/.exec(hash);
  if (!m) return { page: "agents", query: {} };
  const name = m[1] === "teams" ? "agents" : m[1];
  if (!(PAGES as readonly string[]).includes(name)) return { page: "agents", query: {} };
  const query: Record<string, string> = {};
  try {
    for (const [k, v] of new URLSearchParams(m[2] ?? "")) query[k] = v;
  } catch { return { page: "agents", query: {} }; }
  return { page: name as Page, query };
}

/** Inverse of parseHash (keys in insertion order, values encodeURIComponent). */
export function toHash(r: Route): string {
  const q = Object.entries(r.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `#/${r.page}${q ? "?" + q : ""}`;
}

/** Reactive current route; follows hashchange. */
export const route = ref<Route>(typeof location === "undefined" ? { page: "agents", query: {} } : parseHash(location.hash));
if (typeof addEventListener !== "undefined") addEventListener("hashchange", () => { route.value = parseHash(location.hash); });
