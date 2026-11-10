import { expect, test } from "bun:test";
import { DENY_NAMES, DENY_HOME_DIRS, DENY_HOME_FILES } from "../src/net/adopt-safe";

const { scanGate, SCAN_DENY_NAMES, SCAN_DENY_HOME } = (await import(`../plugin/hooks/register.ts${"?gate"}`)) as { scanGate: (t: string, e: Record<string, unknown>, r: string[], h: string) => string | null; SCAN_DENY_NAMES: RegExp[]; SCAN_DENY_HOME: string[] };
const roots = ["/w/harbor", "/h/.claude"];
test("the scan gate denylist equals the one in adopt-safe", () => {
  expect(SCAN_DENY_NAMES.map(String)).toEqual(DENY_NAMES.map(String));
  expect(SCAN_DENY_HOME).toEqual([...DENY_HOME_DIRS, ...DENY_HOME_FILES]);
});
test("adopt and task tools pass; Bash, Write, Edit and web tools are denied", () => {
  for (const t of ["mcp__agentnet__adopt_facts", "mcp__agentnet__adopt_report", "mcp__agentnet__task_start", "ToolSearch"]) expect(scanGate(t, {}, roots, "/h")).toBeNull();
  for (const t of ["Bash", "Write", "Edit", "WebFetch", "Agent", "mcp__agentnet__send"]) expect(scanGate(t, {}, roots, "/h")).toContain("read-only phase");
});
test("Read, Glob and Grep stay inside the roots and off the denylist", () => {
  expect(scanGate("Read", { file_path: "/w/harbor/CLAUDE.md" }, roots, "/h")).toBeNull();
  expect(scanGate("Grep", { path: "/h/.claude" }, roots, "/h")).toBeNull();
  expect(scanGate("Read", { file_path: "/etc/passwd" }, roots, "/h")).toContain("outside");
  expect(scanGate("Read", { file_path: "/w/harbor/../other/x" }, roots, "/h")).toContain("outside");
  expect(scanGate("Read", { file_path: "/w/harbor/.env" }, roots, "/h")).toContain("denied");
  expect(scanGate("Read", { file_path: "/w/harbor/ios" }, roots, "/h")).toBeNull();
  expect(scanGate("Read", { file_path: "relative.md" }, roots, "/h")).toContain("absolute");
  expect(scanGate("Read", { file_path: "/h/.ssh/id_rsa" }, ["/h"], "/h")).toContain("denied");
  expect(scanGate("Read", { file_path: "/h/.aws/config" }, ["/h"], "/h")).toContain("denied");
});
