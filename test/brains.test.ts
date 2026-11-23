import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOP, fetchAsRoot } from "./helpers";

// Brains: a fixed inventory outside the repo (AGENTNET_BRAINS_DIR). Selection is explicit > role > role's last word > default.
const home = mkdtempSync(join(tmpdir(), "an-brains-"));
const bdir = join(home, "brains"); mkdirSync(bdir);
process.env.AGENTNET_HOME = home;
const brain = (name: string, version: number, body: string, extra = "") =>
  writeFileSync(join(bdir, `${name}.md`), `---\nname: ${name}\ndescription: "Test brain: ${name}"\nversion: ${version}\nchangelog:\n  - {v: ${version}, date: 2026-11-19, msg: 1, change: "x"}\n${extra}---\n${body}\n`);
brain("generalist", 1, "GENERALIST BODY");
brain("motion", 3, "MOTION BODY: pick motion.dev or anime.js per case", "reads:\n  - ~/rules/a.md\nskills: [ui-animation, review-animations]\n");
brain("architect", 2, "ARCHITECT BODY");
writeFileSync(join(bdir, "index.json"), JSON.stringify({ default: "generalist", roles: { motion: "motion", architect: "architect", animator: "motion" } }));
beforeAll(() => { process.env.AGENTNET_BRAINS_DIR = bdir; });
afterAll(() => { delete process.env.AGENTNET_BRAINS_DIR; });

const { pickBrain, loadBrain, BrainError } = await import("../src/net/brains");
const { buildApp, makeFetch } = await import("../src/server");
{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../src/core/db"); useDatabase(new Database(":memory:")); (await import("../src/net/store"))._reset(); }
const f = await fetchAsRoot(makeFetch(buildApp()));
const call = (path: string, body?: unknown) => f(new Request(`http://x${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), LOOP);

test("loadBrain strips the frontmatter, heads the text with name, version, reads and skills", () => {
  const b = loadBrain("motion");
  expect(b.id).toBe("motion@v3");
  expect(b.text).toStartWith("# Brain: motion v3\nTest brain: motion\nRead these before any work: ~/rules/a.md.\nLoad these skills with the Skill tool before the work they cover: ui-animation, review-animations.");
  expect(b.text).toContain("MOTION BODY"); expect(b.text).not.toContain("changelog");
});

test("selection: explicit > role > last dash word > default; no index = off", () => {
  expect(pickBrain("architect")?.id).toBe("architect@v2");
  expect(pickBrain("event-architect")?.why).toBe("brain architect@v2: role word architect");
  expect(pickBrain("backend")?.id).toBe("generalist@v1");
  expect(pickBrain("backend", "motion")?.why).toBe("brain motion: explicit");
  process.env.AGENTNET_BRAINS_DIR = join(home, "none");
  try { expect(pickBrain("architect")).toBeNull(); } finally { process.env.AGENTNET_BRAINS_DIR = bdir; }
});

test("a missing or broken brain is an error, never a silent fallback", () => {
  expect(() => loadBrain("nope")).toThrow(BrainError);
  expect(() => loadBrain("../etc")).toThrow(BrainError);
  writeFileSync(join(bdir, "broken.md"), "---\nname: broken\nversion: x\n---\nbody\n");
  expect(() => loadBrain("broken")).toThrow(/integer version/);
});

test("spawn records the brain id on the agent and returns its text for the system prompt", async () => {
  const r = await call("/v1/admin/spawn", { name: "animator-1", job: "animate the tab switch" });
  expect(r.status).toBe(201);
  const j = await r.json() as { brain: string; brain_text: string; soul: string | null; token_file: string };
  expect(j.brain).toBe("motion@v3"); expect(j.brain_text).toContain("MOTION BODY"); expect(j.soul).toBeNull();
  const a = await (await call("/v1/agent/agents/animator-1")).json() as { agent: { soul: string } };
  expect(a.agent.soul).toBe("motion@v3");
});

test("spawn with an unknown --brain is refused and creates no agent", async () => {
  const r = await call("/v1/admin/spawn", { name: "backend-3", job: "x", brain: "nope" });
  expect(r.status).toBe(422); expect(JSON.stringify(await r.json())).toContain("brain 'nope' not found");
  expect((await call("/v1/agent/agents/backend-3")).status).toBe(404);
});

test("spawn-agent.sh writes the brain text first in the appended system prompt file", async () => {
  const src = readFileSync(join(import.meta.dir, "..", "scripts", "spawn-agent.sh"), "utf8");
  expect(src).toContain('--brain) BRAIN=');
  expect(src).toContain('head = (brain + "\\n\\n---\\n") if brain else ""');
});

test("GET /v1/panel/brains lists the inventory from the frontmatter, never the body; notes and broken files handled", async () => {
  writeFileSync(join(bdir, "DESIGN.md"), "# notes, not a brain\n");
  const r = await call("/v1/panel/brains");
  expect(r.status).toBe(200);
  const j = await r.json() as { default: string; roles: Record<string, string>; brains: { name: string; version: number | null; description: string; changelog: { v: number; date: string; source: string; change: string }[]; reads: string[]; skills: string[]; lines: number; roles: string[]; uses: number; grade_avg: number | null; error?: string }[] };
  expect(j.default).toBe("generalist"); expect(j.roles.animator).toBe("motion");
  expect(j.brains.map((b) => b.name)).toEqual(["architect", "broken", "generalist", "motion"]);
  const m = j.brains.find((b) => b.name === "motion")!;
  expect(m.version).toBe(3); expect(m.description).toBe("Test brain: motion");
  expect(m.changelog[0]).toEqual({ v: 3, date: "2026-11-19", source: "msg 1", change: "x" });
  expect(m.reads).toEqual(["~/rules/a.md"]); expect(m.skills).toEqual(["ui-animation", "review-animations"]);
  expect(m.roles).toEqual(["animator", "motion"]); expect(m.lines).toBe(1);
  expect(m.uses).toBeGreaterThanOrEqual(1); expect(m.grade_avg).toBeNull();
  expect(j.brains.find((b) => b.name === "broken")!.error).toMatch(/integer version/);
  expect(JSON.stringify(j)).not.toContain("MOTION BODY");
});

test("POST /v1/panel/brains/import writes a version-1 brain from a catalog persona, commits it, never overwrites", async () => {
  const ars = join(home, "arsenal"); mkdirSync(join(ars, "r"), { recursive: true });
  writeFileSync(join(ars, "r", "vue.md"), "---\nname: vue-pro\ntools: Read\n---\nYOU WRITE VUE.\n");
  writeFileSync(join(ars, "catalog.json"), JSON.stringify({ agents: [{ id: "r/vue-pro", name: "vue-pro", repo: "o/r", path: "r/vue.md", stars: 1, licence: "MIT", category: "frontend", description: "Vue 3 \"expert\": composition API", tools: [], tags: [] }] }));
  process.env.AGENTNET_ARSENAL_DIR = ars;
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", bdir, ...a], { stdout: "ignore", stderr: "ignore" }).exitCode;
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  try {
    const r = await call("/v1/panel/brains/import", { catalogId: "r/vue-pro", name: "vue-pro" });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ name: "vue-pro", committed: true });
    const b = loadBrain("vue-pro");
    expect(b.id).toBe("vue-pro@v1"); expect(b.text).toContain("YOU WRITE VUE."); expect(b.text).not.toContain("tools: Read");
    const raw = readFileSync(join(bdir, "vue-pro.md"), "utf8");
    expect(raw).toContain('description: "Vue 3 \\"expert\\": composition API"'); expect(raw).toContain('change: "imported from r/vue-pro"');
    const l = await (await call("/v1/panel/brains")).json() as { brains: { name: string; version: number; changelog: { change: string }[] }[] };
    expect(l.brains.find((x) => x.name === "vue-pro")).toMatchObject({ version: 1, changelog: [{ change: "imported from r/vue-pro" }] });
    expect((await call("/v1/panel/brains/import", { catalogId: "r/vue-pro", name: "vue-pro" })).status).toBe(409);
    expect((await call("/v1/panel/brains/import", { catalogId: "r/vue-pro", name: "motion" })).status).toBe(409);
    expect((await call("/v1/panel/brains/import", { catalogId: "r/vue-pro", name: "../x" })).status).toBe(400);
    expect((await call("/v1/panel/brains/import", { catalogId: "r/nope", name: "nope" })).status).toBe(404);
    expect(readFileSync(join(bdir, "motion.md"), "utf8")).toContain("MOTION BODY");
  } finally { delete process.env.AGENTNET_ARSENAL_DIR; }
});
