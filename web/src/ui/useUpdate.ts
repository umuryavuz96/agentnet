// Wires the update state machine (ui/update.ts) to the server: status polling, the progress stream, health polling while
// agentnet restarts, and the one-second clock. The sheet and the header pill both read what this returns.
import { onBeforeUnmount, ref } from "vue";
import { api, url } from "./api";
import { initial, reduce, type Action, type Model, type Status, type UpdateEvent } from "./update";

const STATUS_MS = 30 * 60_000;
const DISMISS_KEY = "agentnet.update.dismissed";
const store = {
  get: () => { try { return localStorage.getItem(DISMISS_KEY); } catch { return null; } },
  set: (v: string) => { try { localStorage.setItem(DISMISS_KEY, v); } catch { /* private window: the pill may come back after a reload */ } },
};

export function useUpdate() {
  const m = ref<Model>({ ...initial(), dismissed: store.get() });
  const now = ref(Date.now());
  /** false once the server answered a manual check with 403 (this page is not on the machine itself). */
  const canCheck = ref(true);
  const checking = ref(false);
  let es: EventSource | null = null, retry: ReturnType<typeof setTimeout> | undefined, clock: ReturnType<typeof setInterval> | undefined;
  let beats = 0;

  const closeStream = () => { es?.close(); es = null; };
  function openStream() {
    const id = m.value.jobId;
    if (es || !id) return;
    const src = new EventSource(url(`v1/panel/update/stream?id=${encodeURIComponent(id)}`));
    es = src;
    src.addEventListener("hello", (e) => { try { dispatch({ type: "events", events: JSON.parse((e as MessageEvent).data) as UpdateEvent[], now: Date.now() }); } catch { /* ignore a torn frame */ } });
    src.addEventListener("event", (e) => { try { dispatch({ type: "events", events: [JSON.parse((e as MessageEvent).data) as UpdateEvent], now: Date.now() }); } catch { /* ignore */ } });
    // Do not let EventSource retry by itself: the reducer decides what a closed stream means.
    src.onerror = () => { if (es === src) { closeStream(); dispatch({ type: "streamClosed", now: Date.now() }); } };
  }

  function effects() {
    const p = m.value.phase;
    const live = p === "running" || p === "restarting" || p === "lost";
    if (live && !clock) clock = setInterval(onClock, 1000);
    if (!live && clock) { clearInterval(clock); clock = undefined; }
    if (!live) closeStream();
    if (m.value.reconnect && live && !es && !retry) retry = setTimeout(() => { retry = undefined; if (m.value.reconnect) openStream(); }, m.value.phase === "running" ? 300 : 1000);
  }
  function dispatch(a: Action) {
    m.value = reduce(m.value, a);
    if (a.type === "dismiss" && m.value.dismissed) store.set(m.value.dismissed);
    effects();
  }

  async function onClock() {
    now.value = Date.now();
    dispatch({ type: "tick", now: now.value });
    const p = m.value.phase;
    if ((p === "restarting" || p === "lost") && ++beats % 2 === 0) {
      try {
        const h = await api<{ name?: string; version?: string }>("v1/health");
        dispatch({ type: "health", ok: h.name === "agentnet", version: h.version, now: Date.now() });
      } catch { dispatch({ type: "health", ok: false, now: Date.now() }); }
    }
  }

  async function refresh() {
    try { dispatch({ type: "status", status: await api<Status>("v1/panel/update"), now: Date.now() }); } catch { /* agentnet is restarting or away; the next poll tries again */ }
  }
  async function check() {
    if (checking.value) return;
    checking.value = true;
    try { dispatch({ type: "status", status: await api<Status>("v1/panel/update/check", { method: "POST", body: {} }), now: Date.now() }); }
    catch (e) { if (/forbidden|403|root/i.test((e as Error).message)) canCheck.value = false; else dispatch({ type: "failed", message: (e as Error).message }); }
    finally { checking.value = false; }
  }
  async function start() {
    const tag = m.value.status?.latest;
    if (m.value.phase !== "confirm" || !tag) return;
    try { const r = await api<{ id: string }>("v1/panel/update/run", { body: { tag: `v${tag}` } }); dispatch({ type: "started", id: r.id }); }
    catch (e) { dispatch({ type: "failed", message: (e as Error).message }); void refresh(); }
  }

  void refresh();
  const poll = setInterval(refresh, STATUS_MS);
  onBeforeUnmount(() => { closeStream(); clearTimeout(retry); clearInterval(clock); clearInterval(poll); });

  return { m, now, canCheck, checking, dispatch, refresh, check, start };
}
