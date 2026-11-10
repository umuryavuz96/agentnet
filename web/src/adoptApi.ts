// Panel routes of the adopt flow (spec section 11). Kept apart from adopt.ts so the pure helpers stay testable without a browser.
import { api } from "./ui/api";
import type { AdoptPlan, AdoptState, Picks } from "./adopt";

const P = "v1/panel/adopt";
export const adoptState = () => api<AdoptState>(P);
export const adoptScan = (dir: string, mode: "director" | "static") => api<{ scanId: string }>(`${P}/scan`, { method: "POST", body: { dir, mode } });
export const adoptCancel = () => api<void>(`${P}/cancel`, { method: "POST", body: {} });
export const adoptPlan = (scanId: string, picks: Picks) => api<AdoptPlan>(`${P}/plan`, { method: "POST", body: { scanId, picks } });
export const adoptApply = (planId: string, confirmGlobal: boolean) => api<{ runId: string }>(`${P}/apply`, { method: "POST", body: { planId, confirmGlobal } });
export const adoptRollback = (runId?: string) => api<void>(`${P}/rollback`, { method: "POST", body: runId ? { runId } : {} });

