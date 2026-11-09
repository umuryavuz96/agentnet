import { reactive } from "vue";

/** Base for every request: the folder the page is served from. the site root when standalone, a path prefix inside a host. */
export const BASE = new URL("./", location.href).pathname;
export const url = (path: string) => BASE + path; // for EventSource, fetch and links

/** Call the API. `path` is relative to BASE with no leading slash: api("v1/panel/teams"). Throws an Error with the server's problem detail. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(BASE + path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail ?? data.title ?? `HTTP ${r.status}`);
  return data as T;
}

export function ago(t: number | null | undefined) {
  if (!t) return "never";
  const d = Date.now() / 1000 - t, a = Math.abs(d), pre = d < 0 ? "in " : "", suf = d < 0 ? "" : " ago";
  if (a < 90) return d < 0 ? "in a moment" : "just now";
  if (a < 5400) return `${pre}${Math.round(a / 60)} min${suf}`;
  if (a < 129600) return `${pre}${Math.round(a / 3600)} h${suf}`;
  return `${pre}${Math.round(a / 86400)} d${suf}`;
}

export const toastMsg = reactive({ text: "", n: 0 });
export function toast(text: string) { toastMsg.text = text; const n = ++toastMsg.n; setTimeout(() => { if (toastMsg.n === n) toastMsg.text = ""; }, 3500); }
