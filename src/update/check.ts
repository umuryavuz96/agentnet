// Which release is newest? One GitHub request at most every 6 h, cached on disk. Page loads never call GitHub.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectedSlug } from "./preflight";
import { parseTag } from "./version";

export interface Latest { tag: string; version: string; url: string; notes: string; publishedAt: string }
export interface CheckCache { checkedAt: number; latest: Latest | null; error?: string }
export interface CheckOpts {
  force?: boolean; home: string; repo: string;
  /** Tests: fake clock and fetch. */
  now?: () => number; fetchFn?: typeof fetch;
}

export const TTL_MS = 6 * 3600_000, FORCE_GAP_MS = 60_000, NOTES_MAX = 20_000;
const cacheFile = (home: string) => join(home, "data", "update-check.json");
export const checkEnabled = () => process.env.AGENTNET_UPDATE_CHECK !== "0";

export function readCache(home: string): CheckCache | null {
  try { const c = JSON.parse(readFileSync(cacheFile(home), "utf8")) as CheckCache; return typeof c.checkedAt === "number" ? c : null; } catch { return null; }
}

export async function check(o: CheckOpts): Promise<CheckCache> {
  const now = (o.now ?? Date.now)();
  if (!checkEnabled()) return { checkedAt: now, latest: null };
  const cached = readCache(o.home);
  if (cached) {
    const age = now - cached.checkedAt;
    if (age < (o.force ? FORCE_GAP_MS : TTL_MS)) return cached;
  }
  const slug = expectedSlug(o.repo);
  let fresh: CheckCache;
  if (!slug) fresh = { checkedAt: now, latest: cached?.latest ?? null, error: "no GitHub repository in package.json" };
  else {
    try {
      const base = (process.env.AGENTNET_UPDATE_API || "https://api.github.com").replace(/\/+$/, "");
      const ver = JSON.parse(readFileSync(join(o.repo, "package.json"), "utf8")).version;
      const r = await (o.fetchFn ?? fetch)(`${base}/repos/${slug}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `agentnet/${ver}` }, signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      const j = (await r.json()) as { tag_name?: unknown; html_url?: unknown; body?: unknown; published_at?: unknown };
      const v = typeof j.tag_name === "string" ? parseTag(j.tag_name) : null;
      const url = typeof j.html_url === "string" && j.html_url.startsWith("https://") ? j.html_url : "";
      fresh = { checkedAt: now, latest: v ? { tag: v.tag, version: v.tag.slice(1), url, notes: typeof j.body === "string" ? j.body.slice(0, NOTES_MAX) : "", publishedAt: typeof j.published_at === "string" ? j.published_at : "" } : null };
    } catch (e) {
      fresh = { checkedAt: now, latest: cached?.latest ?? null, error: (e as Error).message }; // errors are cached too: an outage must not mean a request per page load
    }
  }
  try {
    mkdirSync(join(o.home, "data"), { recursive: true });
    const t = `${cacheFile(o.home)}.tmp`; writeFileSync(t, JSON.stringify(fresh)); renameSync(t, cacheFile(o.home));
  } catch { /* cache is best effort */ }
  return fresh;
}
