/** Pairing requests from apps (the Mac app's "Approve on agentnet"): polled every 5 s while the tab shows, shared by the Asks
 *  page and the rail count. Approve or deny by the short user code; the server mints the device token. */
import { ref } from "vue";
import { api } from "./ui/api";

export interface PairReq { user_code: string; name: string; created: number; expires: number }
export const pairRequests = ref<PairReq[]>([]);
export async function loadPairs() {
  try { pairRequests.value = (await api<{ requests: PairReq[] }>("v1/panel/pair/requests")).requests; } catch { /* signed out or old server: none */ }
}
/** "approve" or "deny" a request; returns an error message or "". */
export async function decidePair(code: string, op: "approve" | "deny"): Promise<string> {
  try { await api(`v1/panel/pair/${op}`, { method: "POST", body: { user_code: code } }); return ""; }
  catch (e) { return (e as Error).message; }
  finally { await loadPairs(); }
}
if (typeof window !== "undefined" && typeof document !== "undefined") {
  void loadPairs();
  setInterval(() => { if (!document.hidden) void loadPairs(); }, 5000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void loadPairs(); });
}
