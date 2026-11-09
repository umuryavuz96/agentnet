import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("fresh machine without ~/.claude/settings.json", () => {
  test("Starter set installs and creates settings.json", async () => {
    const d = mkdtempSync(join(tmpdir(), "an-fresh-"));
    const f = join(d, ".claude", "settings.json");
    process.env.CLAUDE_SETTINGS_FILE = f;
    const { installSet } = await import("../src/net/hooks");
    const r = installSet({});
    expect(r.added.length).toBeGreaterThan(0);
    expect(existsSync(f)).toBe(true);
    const s = JSON.parse(readFileSync(f, "utf8"));
    expect(Object.keys(s.hooks ?? {}).length).toBeGreaterThan(0);
    delete process.env.CLAUDE_SETTINGS_FILE;
  });
});
