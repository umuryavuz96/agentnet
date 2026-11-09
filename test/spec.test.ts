import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { V1_PATHS } from "../src/net/mount";

test("openapi.yaml lists exactly V1_PATHS", () => {
  const y = readFileSync(join(import.meta.dir, "../spec/openapi.yaml"), "utf8");
  const found = [...y.matchAll(/^ {2}(\/v1\/[^:]+):$/gm)].map((m) => m[1]);
  expect(new Set(found)).toEqual(new Set(V1_PATHS));
  expect(found.length).toBe(V1_PATHS.length);
});
