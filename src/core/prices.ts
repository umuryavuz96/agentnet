import { readFileSync } from "node:fs";
import PRICES from "./modelPrices.json";

export interface ModelPrice { match: string; in: number; out: number; cacheRead?: number; cacheWrite5m?: number; cacheWrite1h?: number }
export function loadPrices(extra = process.env.AGENTNET_PRICES_FILE): ModelPrice[] {
  let own: ModelPrice[] = [];
  try { if (extra) own = (JSON.parse(readFileSync(extra, "utf8")).models ?? []) as ModelPrice[]; } catch { /* bad file: built-ins only */ }
  return [...own, ...(PRICES as { models: ModelPrice[] }).models];
}
export const priceFor = (model: string, table: ModelPrice[]) => table.find((p) => model.toLowerCase().includes(p.match)) ?? null;

/** Tokens: [input, output, cacheRead, cacheWrite5m, cacheWrite1h, messages]. Dollars at list price. */
export type Tok = [number, number, number, number, number, number];
export function costUsd(t: Tok, p: ModelPrice): number {
  return (t[0] * p.in + t[1] * p.out + t[2] * (p.cacheRead ?? p.in * 0.1) + t[3] * (p.cacheWrite5m ?? p.in * 1.25) + t[4] * (p.cacheWrite1h ?? p.in * 2)) / 1e6;
}
