import { describe, expect, test } from "bun:test";
import { accountInitial, capsulePath, holdShift, isFoldKey, readCollapsed, ringColor, writeCollapsed } from "./sidebar";

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
const key = (o: Partial<Parameters<typeof isFoldKey>[0]>) => ({ ctrlKey: true, metaKey: true, altKey: false, shiftKey: false, code: "KeyS", ...o });

describe("sidebar", () => {
  test("starts grown and remembers the fold", () => {
    const s = mem();
    expect(readCollapsed(s)).toBe(false);
    writeCollapsed(true, s); expect(readCollapsed(s)).toBe(true);
    writeCollapsed(false, s); expect(readCollapsed(s)).toBe(false);
  });
  test("blocked storage keeps it grown and never throws", () => {
    expect(readCollapsed(blocked)).toBe(false);
    expect(() => writeCollapsed(true, blocked)).not.toThrow();
  });
  test("only Control Command S folds", () => {
    expect(isFoldKey(key({}))).toBe(true);
    for (const o of [{ ctrlKey: false }, { metaKey: false }, { altKey: true }, { shiftKey: true }, { code: "KeyK" }]) expect(isFoldKey(key(o))).toBe(false);
  });
  test("ring colour follows the Mac thresholds", () => {
    expect([0, 49.9, 50, 79.9, 80, 100].map(ringColor)).toEqual(["var(--on)", "var(--on)", "var(--pend)", "var(--pend)", "var(--bad)", "var(--bad)"]);
  });
  test("ring outline starts at the top centre, circle or pill", () => {
    expect(capsulePath(40, 40)).toBe("M20 0H20A20 20 0 0 1 20 40H20A20 20 0 0 1 20 0H20");
    expect(capsulePath(140, 40).startsWith("M70 0H120A20 20")).toBe(true);
  });
  // The 3D office once slid by the 2D map's 120 px while its centre moved 160 px: two offices cross-faded, 40 px apart.
  test("a fold in 3D shows one office: the new picture stands still and the camera starts where the old office was", async () => {
    const css = await Bun.file(new URL("./components/Sidebar.vue", import.meta.url)).text();
    expect(css).not.toMatch(/\.o3\)\{--side-d/);
    expect(css).toContain(":has(.shell .o3)::view-transition-new(side-page){animation:none;mix-blend-mode:normal}");
    // the box centre moves from 1110 to 950 px: at 50 px per unit the camera target moves 3.2 units left
    expect(holdShift(1110, 950, 50)).toBeCloseTo(-3.2);
  });
  test("account letter", () => {
    expect(["agentnet.home", "localhost", "127.0.0.1", ""].map(accountInitial)).toEqual(["A", "L", "A", "A"]);
  });
});
