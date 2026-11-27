import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-agentnet-"));
await import("./routes"); // first, as the other tests do: it loads the modules around liveness in an order that has no cycle
const { MCP_FRESH, mcpReady, mcpReported, mcpReset, mcpSwitch, mcpTake, mcpView, setMcpCapable, setMcpWaker } = await import("./mcpControl");
const { pollOpened } = await import("./liveness");
const routesWaker = setMcpWaker(() => {}); afterAll(() => { setMcpWaker(routesWaker); }); // the routes tests run in this process too

const rows = (probeOn = true) => [{ name: "probe", status: "connected", on: probeOn, tools: 1 }, { name: "broken", status: "failed", on: true }];
/** A polling agent whose plugin can switch. */
function live(name: string) { mcpReset(); const woke: string[] = []; setMcpWaker((n) => woke.push(n)); setMcpCapable(name, true); pollOpened(`${name}#1`); return { id: `${name}#1`, woke }; }

describe("per-session MCP switch", () => {
  test("asking wakes the plugin for a report, which the next view shows; a fresh report is not asked again", () => {
    const { id, woke } = live("m-1");
    expect(mcpView("m-1", id)).toEqual({ capable: true, at: null, servers: [] });
    expect(woke).toEqual(["m-1"]); expect(mcpTake("m-1")).toEqual({ set: [] }); expect(mcpTake("m-1")).toBeNull();
    mcpReported("m-1", rows(), 1000);
    expect(mcpView("m-1", id, 1000 + MCP_FRESH - 1).servers).toEqual(rows().map((s) => ({ ...s, pending: false })) as never);
    expect(mcpReady("m-1")).toBe(false);
    mcpView("m-1", id, 1000 + MCP_FRESH); expect(mcpReady("m-1")).toBe(true);
  });
  test("a switch is pending until the plugin has taken it and reported", () => {
    const { id } = live("m-2"); mcpReported("m-2", rows());
    expect(mcpSwitch("m-2", id, "probe", false)).toBe(true);
    expect(mcpView("m-2", id).servers[0]).toMatchObject({ name: "probe", on: false, pending: true });
    mcpReported("m-2", rows(true)); // a report written before the plugin fetched the switch settles nothing
    expect(mcpView("m-2", id).servers[0]).toMatchObject({ on: false, pending: true });
    expect(mcpTake("m-2")).toEqual({ set: [{ server: "probe", on: false }] });
    mcpReported("m-2", rows(false));
    expect(mcpView("m-2", id).servers[0]).toMatchObject({ on: false, pending: false });
  });
  test("no switch for an unlisted server, an older plugin or a plugin that stopped polling", () => {
    const { id } = live("m-3"); mcpReported("m-3", rows());
    expect(mcpSwitch("m-3", id, "nope", false)).toBe(false);
    expect(mcpSwitch("m-3", "never-polled", "probe", false)).toBe(false);
    expect(mcpView("m-3", "never-polled").capable).toBe(false);
    setMcpCapable("m-3", false);
    expect(mcpSwitch("m-3", id, "probe", false)).toBe(false); expect(mcpView("m-3", id)).toEqual({ capable: false, at: null, servers: [] });
  });
  test("a hello drops the old report; a switch not fetched yet stays", () => {
    const { id, woke } = live("m-4"); mcpReported("m-4", rows()); mcpSwitch("m-4", id, "probe", false); woke.length = 0;
    setMcpCapable("m-4", true);
    expect(woke).toEqual(["m-4"]); expect(mcpView("m-4", id).servers).toEqual([]);
    expect(mcpTake("m-4")).toEqual({ set: [{ server: "probe", on: false }] });
  });
  test("a report is cleaned: unknown statuses, nameless rows and long names", () => {
    const { id } = live("m-5");
    mcpReported("m-5", [{ name: "x".repeat(300), status: "weird", tools: -1 }, { status: "connected" }, null]);
    expect(mcpView("m-5", id).servers).toEqual([{ name: "x".repeat(120), status: "unknown", on: true, pending: false }]);
    mcpReported("m-5", "junk"); expect(mcpView("m-5", id).servers).toEqual([]);
  });
});
