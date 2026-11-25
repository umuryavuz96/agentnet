import { describe, expect, test } from "bun:test";
import { agentClosed, serviceDown } from "./agentClosed";
import type { AgentRow } from "./net";

const row = (life: AgentRow["life"], extra: Partial<AgentRow> = {}) => ({ id: "a1", name: "builder-x", life, lifeSince: 1700, state: "idle", ...extra }) as AgentRow;
const up = { connected: true, lastFrameAt: 1000 };

describe("agentClosed: gone vs idle", () => {
  test("a despawned agent that keeps its row is closed, with the time it closed", () => {
    expect(agentClosed("builder-x", row("gone"), up)).toEqual({ closed: true, at: 1700 });
    expect(agentClosed("builder-x", row("failed"), up)).toEqual({ closed: true, at: 1700 });
  });
  test("an agent no longer on the map is closed, time unknown", () => {
    expect(agentClosed("builder-x", null, up)).toEqual({ closed: true, at: null });
  });
  test("an idle, starting or stopping agent that is still listed is not closed", () => {
    for (const l of ["live", "starting", "stopping"] as const) expect(agentClosed("builder-x", row(l), up).closed).toBe(false);
    expect(agentClosed("builder-x", row("live", { connectedAt: undefined }), up).closed).toBe(false);
  });
  test("a missing row says nothing before the first frame or while the stream is down", () => {
    expect(agentClosed("builder-x", null, { connected: false, lastFrameAt: 0 }).closed).toBe(false);
    expect(agentClosed("builder-x", null, { connected: true, lastFrameAt: 0 }).closed).toBe(false);
    expect(agentClosed("builder-x", null, { connected: false, lastFrameAt: 1000 }).closed).toBe(false);
  });
  test("root is never closed", () => {
    expect(agentClosed("root", null, up).closed).toBe(false);
    expect(agentClosed("root", row("gone"), up).closed).toBe(false);
  });
});

describe("serviceDown", () => {
  test("down only after frames came and the stream closed", () => {
    expect(serviceDown({ connected: false, lastFrameAt: 0 })).toBe(false);
    expect(serviceDown({ connected: true, lastFrameAt: 5 })).toBe(false);
    expect(serviceDown({ connected: false, lastFrameAt: 5 })).toBe(true);
  });
});
