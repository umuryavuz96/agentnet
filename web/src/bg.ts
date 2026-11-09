// Background-work rows: which to show and in which state. Pure, so it is unit tested.
import type { BgRow } from "./net";
export const BG_KEEP_MS = 2 * 60_000, BG_STALE_MS = 60 * 60_000;
export type BgShown = BgRow["state"] | "stale";
/** A row still "running" after an hour has most likely lost its done signal: show it as stale (dimmed). */
export const bgShown = (b: BgRow, now: number): BgShown => (b.state === "running" && now - b.startedAt > BG_STALE_MS ? "stale" : b.state);
/** Rows to draw: live ones, plus finished ones for BG_KEEP_MS; a stale row fades out BG_KEEP_MS after it turned stale. */
export const bgVisible = (rows: BgRow[] | undefined, now: number): BgRow[] =>
  (rows ?? []).filter((b) => (b.state === "running" ? now - b.startedAt < BG_STALE_MS + BG_KEEP_MS : now - (b.endedAt ?? now) < BG_KEEP_MS));
