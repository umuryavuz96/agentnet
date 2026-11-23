import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowOwnerPath, assertInHome, inHome, ownerPaths } from "./paths";

const base = mkdtempSync(join(tmpdir(), "an-paths-"));
const home = join(base, "agentnet"), sib = join(base, "agentnet2"), out = join(base, "outside");
for (const d of [home, sib, out]) mkdirSync(d, { recursive: true });
afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(() => { delete process.env.AN_TEST_OWNER_FILE; delete process.env.CLAUDE_SETTINGS_FILE; });

describe("inHome", () => {
  test("a path inside the home, existing or not, is inside", () => {
    expect(inHome(join(home, "claude", "base", "settings.json"), home)).toBe(true);
    expect(inHome(home, home)).toBe(true);
  });
  test("a sibling with the same prefix is outside", () => {
    expect(inHome(join(sib, "x.json"), home)).toBe(false);
  });
  test("a symlink inside the home that points outside is outside (dir link and file link)", () => {
    symlinkSync(out, join(home, "escape"));
    expect(inHome(join(home, "escape", "settings.json"), home)).toBe(false);
    writeFileSync(join(out, "f.json"), "{}");
    symlinkSync(join(out, "f.json"), join(home, "f.json"));
    expect(inHome(join(home, "f.json"), home)).toBe(false);
  });
  test("a dangling symlink inside never counts as inside", () => {
    symlinkSync(join(out, "missing.json"), join(home, "dangling.json"));
    expect(inHome(join(home, "dangling.json"), home)).toBe(false);
  });
  test("a path with .. segments is outside, even when it resolves inside", () => {
    expect(inHome(join(home, "a") + "/../b.json", home)).toBe(false);
    expect(inHome(home + "/../outside/x", home)).toBe(false);
  });
});

describe("assertInHome and owner paths", () => {
  test("refuses an outside path with the guard message", () => {
    expect(() => assertInHome(join(out, "settings.json"), "hooks", home)).toThrow(`agentnet: refusing to write outside its folder: ${join(out, "settings.json")} (hooks)`);
    expect(() => assertInHome(join(home, "x.json"), "hooks", home)).not.toThrow();
  });
  test("an owner-chosen path is allowed with its own backups, and listed", () => {
    const f = join(out, "owner.json");
    process.env.AN_TEST_OWNER_FILE = f;
    expect(allowOwnerPath("AN_TEST_OWNER_FILE")).toBe(f);
    expect(() => assertInHome(f, "x", home)).not.toThrow();
    expect(() => assertInHome(`${f}.bak-agentnet-1`, "x", home)).not.toThrow();
    expect(() => assertInHome(join(out, "other.json"), "x", home)).toThrow("refusing to write outside");
    expect(ownerPaths(home)).toContainEqual({ env: "AN_TEST_OWNER_FILE", path: f });
  });
  test("an unset owner variable allows nothing and is not listed", () => {
    expect(allowOwnerPath("AN_TEST_OWNER_FILE")).toBeUndefined();
    expect(ownerPaths(home).some((o) => o.env === "AN_TEST_OWNER_FILE")).toBe(false);
  });
});
