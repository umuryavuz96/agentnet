import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ws-souls-"));
const wsd = join(tmp, "workspace"), ars = join(tmp, "arsenal"), repo = join(tmp, "harbor", "ios"), kmp = join(tmp, "harbor", "kmp");
const ENV = ["AGENTNET_WORKSPACE_DIR", "AGENTNET_ARSENAL_DIR"];
beforeAll(() => {
  process.env.AGENTNET_WORKSPACE_DIR = wsd; process.env.AGENTNET_ARSENAL_DIR = ars;
  mkdirSync(ars, { recursive: true }); mkdirSync(join(repo, ".claude", "agents"), { recursive: true }); mkdirSync(kmp, { recursive: true });
  writeFileSync(join(ars, "catalog.json"), JSON.stringify({ agents: [{ id: "r/a", name: "A", path: "a.md", category: "qa", tags: [], description: "d" }] }));
  writeFileSync(join(ars, "a.md"), "Be A.");
  writeFileSync(join(ars, "roles.json"), JSON.stringify({ roles: { qa: { default: "r/a" } } }));
  writeFileSync(join(repo, ".claude", "agents", "ios.md"), "---\nname: ios\ndescription: Builds the iOS app\ntools: Read, Edit\nmodel: sonnet\n---\nYou build the iOS app.\n");
  writeFileSync(join(kmp, "CLAUDE.md"), "kmp rules");
});
afterAll(() => { for (const k of ENV) delete process.env[k]; });
const ws = await import("./workspace");
const { loadCatalog, loadRoles, personaOf } = await import("./arsenal");
const defFile = () => join(repo, ".claude", "agents", "ios.md");

describe("workspace souls", () => {
  test("agent-def and claude-md souls are created; source files untouched", () => {
    const before = readFileSync(defFile(), "utf8");
    const r = ws.registerSouls([{ repo, name: "ios", source: "agent-def", defFile: defFile() }, { repo: kmp, name: "kmp", source: "claude-md" }], { runId: "run-1", builtinRoles: ["qa"] });
    expect(r.errors).toEqual([]);
    expect(readFileSync(join(wsd, "souls", "ios.md"), "utf8")).toBe(`You build the iOS app.\n\nYour repo is ${repo}. Work there.\n`);
    expect(readFileSync(join(wsd, "souls", "kmp.md"), "utf8")).toContain(`${join(kmp, "CLAUDE.md")} for every rule`);
    const e = ws.wsCatalog().find((a) => a.id === "ws/ios")!;
    expect(e).toMatchObject({ category: "workspace", licence: "user", stars: 0, tools: ["Read", "Edit"], model_hint: "sonnet", project: repo, role: "ios", review: { status: "user-approved", note: "registered by run run-1" } });
    expect(e.sourceSha).toHaveLength(64);
    expect(readFileSync(defFile(), "utf8")).toBe(before);
  });
  test("loadCatalog and loadRoles merge; shipped files are not written", () => {
    expect(loadCatalog().agents.map((a) => a.id)).toEqual(["r/a", "ws/ios", "ws/kmp"]);
    expect(loadRoles().roles.ios!.default).toBe("ws/ios");
    expect(loadRoles().roles.qa!.default).toBe("r/a");
    expect(readFileSync(join(ars, "roles.json"), "utf8")).not.toContain("ws/");
    expect(readFileSync(join(ars, "catalog.json"), "utf8")).not.toContain("ws/");
  });
  test("personaOf reads a workspace soul; traversal is refused", () => {
    expect(personaOf("ws/ios")!.body).toContain("You build the iOS app.");
    const cat = JSON.parse(readFileSync(join(wsd, "catalog.json"), "utf8"));
    cat.agents.push({ ...cat.agents[0], id: "ws/evil", path: "../../etc/passwd" });
    writeFileSync(join(wsd, "catalog.json"), JSON.stringify(cat));
    expect(personaOf("ws/evil")).toBeNull();
    cat.agents.pop(); writeFileSync(join(wsd, "catalog.json"), JSON.stringify(cat));
  });
  test("a role clash registers the soul without a role mapping", () => {
    const r = ws.registerSouls([{ repo: kmp, name: "qa", source: "claude-md" }], { runId: "run-2", builtinRoles: ["qa"] });
    expect(r.roleClash).toEqual(["qa"]);
    expect(ws.wsRoles().qa).toBeUndefined();
    expect(loadRoles().roles.qa!.default).toBe("r/a");
    expect(ws.wsCatalog().find((a) => a.id === "ws/qa")!.role).toBeUndefined();
  });
  test("bad name, missing or outside def file, secret file name are skipped with a reason", () => {
    writeFileSync(join(tmp, "elsewhere.md"), "x"); writeFileSync(join(repo, ".env"), "T=1");
    const r = ws.registerSouls([
      { repo, name: "Bad Name", source: "claude-md" },
      { repo, name: "x1", source: "agent-def", defFile: join(tmp, "elsewhere.md") },
      { repo, name: "x2", source: "agent-def", defFile: join(repo, ".env") },
      { repo, name: "x3", source: "agent-def" },
    ], { runId: "run-3" });
    expect(r.entries).toEqual([]);
    expect(r.errors).toHaveLength(4);
  });
  test("a symlinked definition that leaves the repo is refused", () => {
    symlinkSync(join(tmp, "elsewhere.md"), join(repo, ".claude", "agents", "link.md"));
    const r = ws.registerSouls([{ repo, name: "lnk", source: "agent-def", defFile: join(repo, ".claude", "agents", "link.md") }], { runId: "run-4" });
    expect(r.errors).toHaveLength(1);
  });
  test("wsRoleSoul finds the repo soul by role", () => {
    expect(ws.wsRoleSoul("ios")!.project).toBe(repo);
    expect(ws.wsRoleSoul("nope")).toBeNull();
  });
  test("pick-soul.sh scores workspace souls and keeps the shipped role first", () => {
    const run = (role: string, extra: string[] = []) => Bun.spawnSync(["bash", join(import.meta.dir, "..", "..", "scripts", "pick-soul.sh"), "--role", role, "--no-log", ...extra], { env: { ...process.env, ARSENAL_DIR: ars, AGENTNET_HOME: tmp } });
    expect(new TextDecoder().decode(run("ios").stdout)).toContain("soul=ws/ios");
    expect(new TextDecoder().decode(run("qa").stdout)).toContain("soul=r/a");
  });
  test("removeSouls for one run deletes only its files and entries; the last run empties the folder files", () => {
    const gone = ws.removeSouls({ runId: "run-2" });
    expect(gone.some((f) => f.endsWith("qa.md"))).toBe(true);
    expect(existsSync(join(wsd, "souls", "ios.md"))).toBe(true);
    expect(ws.wsCatalog().map((a) => a.id)).toEqual(["ws/ios", "ws/kmp"]);
    ws.removeSouls({ runId: "run-1" });
    expect(existsSync(join(wsd, "catalog.json"))).toBe(false);
    expect(existsSync(join(wsd, "souls", "ios.md"))).toBe(false);
    expect(loadCatalog().agents.map((a) => a.id)).toEqual(["r/a"]);
  });
});
