import { describe, expect, test } from "bun:test";
import { sections } from "./changelog";
import { parseTag } from "./version";

const v = (t: string) => parseTag(t)!;
const MD = `# Changelog

## 0.4.0

Four.

### New

- thing

## Weird heading

skipped

## 0.3.1

Three-one.

## 0.3.0

Three.
`;

describe("sections (T19)", () => {
  test("range is (from, to], newest first", () => {
    const s = sections(MD, v("v0.3.0"), v("v0.4.0"));
    expect(s.indexOf("## 0.4.0")).toBeGreaterThanOrEqual(0);
    expect(s.indexOf("## 0.4.0")).toBeLessThan(s.indexOf("## 0.3.1"));
    expect(s).not.toContain("## 0.3.0");
    expect(s).toContain("### New");
    expect(s).not.toContain("skipped");
  });
  test("to is inclusive, from exclusive", () => {
    expect(sections(MD, v("v0.3.0"), v("v0.3.1"))).toBe("## 0.3.1\n\nThree-one.");
    expect(sections(MD, v("v0.3.1"), v("v0.3.1"))).toBe("");
  });
  test("sorts by version, not by file order", () => {
    const flipped = "## 0.3.1\n\na\n\n## 0.4.0\n\nb\n";
    expect(sections(flipped, v("v0.3.0"), v("v0.4.0")).startsWith("## 0.4.0")).toBe(true);
  });
  test("accepts [0.4.0] and v0.4.0 headings", () => {
    expect(sections("## [0.4.0] - 2026\n\nx\n", v("v0.3.0"), v("v0.4.0"))).toContain("x");
    expect(sections("## v0.4.0\n\nx\n", v("v0.3.0"), v("v0.4.0"))).toContain("x");
  });
});
