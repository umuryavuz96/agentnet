import { describe, expect, test } from "bun:test";
import { cmp, fromPackage, newest, parseTag } from "./version";

describe("parseTag (T1)", () => {
  test("accepts plain release tags", () => {
    expect(parseTag("v0.4.0")).toEqual({ major: 0, minor: 4, patch: 0, tag: "v0.4.0" });
    expect(parseTag("v10.20.30")?.minor).toBe(20);
  });
  test.each(["v0.4.0-rc1", "0.4.0", "v01.2.3", "v1.2", "nightly", "v1.2.3;rm", "v1.2.3\n", " v1.2.3", "v1.2.3.4", "v1.-2.3", "v1.2.1234567890"])("rejects %j", (t) => {
    expect(parseTag(t)).toBeNull();
  });
});

describe("compare", () => {
  test("cmp orders by major, minor, patch", () => {
    const v = (t: string) => parseTag(t)!;
    expect(cmp(v("v0.4.0"), v("v0.3.9"))).toBeGreaterThan(0);
    expect(cmp(v("v1.0.0"), v("v0.99.99"))).toBeGreaterThan(0);
    expect(cmp(v("v0.3.1"), v("v0.3.1"))).toBe(0);
    expect(cmp(v("v0.3.9"), v("v0.3.10"))).toBeLessThan(0);
  });
  test("newest ignores non-release tags (T2)", () => {
    expect(newest(["v0.3.0", "v0.3.1", "v0.4.0-rc1", "nightly", "v0.4.0"])?.tag).toBe("v0.4.0");
    expect(newest(["nightly", "v0.5.0-rc1"])).toBeNull();
    expect(newest([])).toBeNull();
  });
  test("fromPackage", () => {
    expect(fromPackage("0.3.0")?.tag).toBe("v0.3.0");
    expect(fromPackage("v0.3.0")).toBeNull();
    expect(fromPackage("0.3.0-beta")).toBeNull();
  });
});
