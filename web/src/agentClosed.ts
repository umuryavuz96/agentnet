// Is the agent behind a chat window closed (despawned, or no longer on the map) or only not running right now?
// Pure, so a test pins it down. The source is the one stream the whole app reads (net.ts): a despawned agent either keeps
// its row with life "gone"/"failed" (lifeSince = when it closed) or loses the row on a `gone` frame. An agent that is
// still listed (idle, starting, stopping, not connected) is not closed. Until the stream has sent its first frame and is
// up, a missing row says nothing: the window must not claim an agent is closed while the map is still loading or offline.
import type { AgentRow } from "./net";

export interface Closed { closed: boolean; at: number | null }

export function agentClosed(name: string, row: AgentRow | null | undefined, stream: { connected: boolean; lastFrameAt: number }): Closed {
  if (name === "root") return { closed: false, at: null }; // root is never despawned; it is only not running
  if (row && (row.life === "gone" || row.life === "failed")) return { closed: true, at: row.lifeSince || null };
  if (row) return { closed: false, at: null };
  if (!stream.connected || stream.lastFrameAt <= 0) return { closed: false, at: null };
  return { closed: true, at: null };
}

/** The service connection is really down: the stream had frames and is now closed (the same test as OfflineBar.vue). */
export const serviceDown = (stream: { connected: boolean; lastFrameAt: number }) => stream.lastFrameAt > 0 && !stream.connected;
