import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-envfile-"));
const { loadEnvFile } = await import("../src/core/envfile");

test("sets only unset keys, expands ~/, keeps = in values, skips bad keys", () => {
  const f = join(mkdtempSync(join(tmpdir(), "an-envf-")), "env");
  writeFileSync(f, "A=1\n# c\n\nB=~/x\nC=a=b\nbad-key=1\n");
  const env: Record<string, string | undefined> = { A: "0" };
  const set = loadEnvFile(f, env, "/home/u");
  expect(env.A).toBe("0");
  expect(env.B).toBe("/home/u/x");
  expect(env.C).toBe("a=b");
  expect("bad-key" in env).toBe(false);
  expect(set).toEqual(["B", "C"]);
});

test("missing file is a no-op", () => {
  const env: Record<string, string | undefined> = { A: "0" };
  expect(loadEnvFile("/nonexistent/an-env", env)).toEqual([]);
  expect(env).toEqual({ A: "0" });
});
