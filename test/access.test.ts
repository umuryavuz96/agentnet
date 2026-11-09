import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-access-"));
const { bindOk, isLoopbackAddr } = await import("../src/core/access");

describe("bindOk", () => {
  test("allowed", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.0.10", "100.64.0.10", "100.127.255.254", "fd7a:115c:a1e0::1"]) expect(bindOk(h)).toBe(true);
  });
  test("refused", () => {
    for (const h of ["0.0.0.0", "::", "8.8.8.8", "172.32.0.1", "100.128.0.1", "example.com", "", "256.1.1.1", "010.0.0.1", "192.168.00.1", "127.0.0.01"]) expect(bindOk(h)).toBe(false);
  });
});
describe("isLoopbackAddr", () => {
  test("loopback", () => { for (const a of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddr(a)).toBe(true); });
  test("not loopback", () => { expect(isLoopbackAddr("192.168.0.10")).toBe(false); expect(isLoopbackAddr(null)).toBe(false); });
});
