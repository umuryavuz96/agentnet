import { expect, test } from "bun:test";
import { badgeLabels, bossOptions, errorsFor, footerCount, footerLabel, groupAllOn, groupCount, groupItems, importedDirector, initLines, isStale, linesFromPlan, markRunning, nameError, needsDirector, opLabel, reduceLines, runSummary, visibleLines, type ImportItem, type ImportPlan, type Progress } from "./importView";

const it = (id: string, kind: ImportItem["kind"], accept = true, extra: Partial<ImportItem> = {}): ImportItem => ({ id, kind, source: "/h/.claude/x", target: "", summary: id, reason: "", accept, badges: [], ...extra });
const items = [it("plugin:p", "plugin", false), it("hook:Stop:0:0", "hook"), it("rule:a.md", "rule"), it("agent:rev", "agent"), it("instruction:CLAUDE.md", "instruction"), it("team:web", "team"), it("env:TOKEN", "settings-env", false), it("mcp:x", "mcp"), it("skill:s", "skill"), it("command:c.md", "command"), it("agent-def:h.md", "agent-def")];
const on = (i: ImportItem) => i.accept;

test("groups come in the fixed order, kinds sorted inside, empty groups dropped", () => {
  const g = groupItems(items, on);
  expect(g.map((x) => x.title)).toEqual(["Agents and teams", "Instructions and rules", "Skills and commands", "Hooks", "Settings", "MCP servers", "Plugins"]);
  expect(g[0]!.rows.map((r) => r.id)).toEqual(["team:web", "agent:rev", "agent-def:h.md"]);
  expect(g[1]!.rows.map((r) => r.id)).toEqual(["instruction:CLAUDE.md", "rule:a.md"]);
  expect(groupItems([it("rule:a.md", "rule")], on).map((x) => x.key)).toEqual(["instructions"]);
});

test("n of m on counts switchable rows; plugins never count", () => {
  const g = groupItems(items, on);
  expect(groupCount(g.find((x) => x.key === "settings")!)).toBe("0 of 1 on");
  expect(groupCount(g.find((x) => x.key === "staff")!)).toBe("3 of 3 on");
  expect(groupCount(g.find((x) => x.key === "plugins")!)).toBe("install by hand");
  expect(groupAllOn(g.find((x) => x.key === "staff")!, on)).toBe(true);
  expect(groupAllOn(g.find((x) => x.key === "settings")!, on)).toBe(false);
});

test("footer count is switchable items that are on", () => {
  expect(footerCount(items, on)).toBe(9);
  expect(footerCount(items, (i) => i.accept || i.kind === "plugin")).toBe(9);
  expect(footerLabel(1)).toBe("Preview 1 item");
  expect(footerLabel(4)).toBe("Preview 4 items");
});

test("badge labels: plain words, tones, Global from home", () => {
  expect(badgeLabels({ badges: ["runs a script outside the folder", "holds a secret"], source: "/p/x" }, "/h")).toEqual([{ label: "Runs a script outside the folder", tone: "warn" }, { label: "Holds a secret", tone: "warn" }]);
  expect(badgeLabels({ badges: ["project"], source: "/h/.claude/settings.json" }, "/h/")).toEqual([{ label: "Project", tone: "info" }, { label: "Global", tone: "info" }]);
  expect(badgeLabels({ badges: [], source: "/h/.claude.json" }, "/h")).toEqual([{ label: "Global", tone: "info" }]);
  expect(badgeLabels({ badges: ["manual"], source: "/h/.claudex/a" }, "/h")).toEqual([{ label: "Manual", tone: "info" }]);
});

test("name validation matches [a-z0-9-]{1,32}", () => {
  expect(nameError("reviewer-2")).toBe("");
  expect(nameError("")).toBe("Give it a name.");
  expect(nameError("Reviewer")).toBe("Only lowercase letters, digits and dashes.");
  expect(nameError("a b")).toBe("Only lowercase letters, digits and dashes.");
  expect(nameError("a".repeat(33))).toBe("At most 32 characters.");
  expect(nameError("a".repeat(32))).toBe("");
});

test("decide errors map to their item; boss options skip self", () => {
  expect(errorsFor(["agent:rev: name rev is a live agent already", "agent:re: x", "team:web: lead y"], "agent:rev")).toEqual(["name rev is a live agent already"]);
  expect(bossOptions("rev", ["rev", "lead"], ["root", "lead", "ops"])).toEqual(["root", "lead", "ops"]);
});

const plan: ImportPlan = { planId: "iplan-1", runId: "imp-1", warnings: [], files: [], ops: [
  { id: "o1", item: "rule:a.md", op: "copy-file", target: "claude/base/rules/a.md", size: 7 },
  { id: "o2", item: null, op: "mark-complete", target: "claude/base/.complete" },
  { id: "o3", item: "team:web", op: "create-team", team: { id: "web" } },
  { id: "o4", item: "agent:rev", op: "create-agent", target: "agents/rev/staff.json", agent: { name: "rev" } },
  { id: "o5", item: "agent:rev", op: "start-agent", name: "rev" },
] };
const ev = (opId: string | undefined, status: string, extra: Partial<Progress> = {}): Progress => ({ type: "import.progress", runId: "imp-1", phase: "apply", ...(opId ? { opId } : {}), status, at: 1, ...extra });

test("op status reducer: pending, running, done, failed; other runs ignored", () => {
  let l = markRunning(initLines(plan), true);
  expect(l.map((x) => x.status)).toEqual(["running", "pending", "pending", "pending", "pending"]);
  l = reduceLines(l, ev("o1", "ok"), "imp-1");
  expect(l.map((x) => x.status)).toEqual(["done", "running", "pending", "pending", "pending"]);
  l = reduceLines(l, ev("o2", "ok", { runId: "imp-other" }), "imp-1");
  expect(l[1]!.status).toBe("running");
  l = reduceLines(l, ev("o2", "failed", { detail: "x changed since preview" }), "imp-1");
  l = reduceLines(l, ev("o3", "skipped"), "imp-1"); l = reduceLines(l, ev("o4", "skipped"), "imp-1"); l = reduceLines(l, ev("o5", "skipped"), "imp-1");
  expect(l.map((x) => x.status)).toEqual(["done", "failed", "skipped", "skipped", "skipped"]);
  expect(l[1]!.error).toBe("x changed since preview");
  const v = visibleLines(l); expect(v.shown.map((x) => x.id)).toEqual(["o1", "o2"]); expect(v.notRun).toBe(3);
  expect(isStale("x changed since preview")).toBe(true); expect(isStale("the plan changed since the preview: preview again")).toBe(true); expect(isStale("disk full")).toBe(false);
});

test("the final apply event stops the running marker; the summary counts what ran", () => {
  let l = initLines(plan);
  for (const id of ["o1", "o2", "o3", "o4", "o5"]) l = reduceLines(l, ev(id, "ok"), "imp-1");
  l = reduceLines(l, ev(undefined, "done"), "imp-1");
  expect(l.every((x) => x.status === "done")).toBe(true);
  expect(runSummary({ files: [{ target: "a" }, { target: "b" }], teams: ["web"] }, plan, l)).toBe("2 files copied, 1 agent created, 1 team created, 1 agent started");
  expect(opLabel(plan.ops[3]!)).toBe("Create agent rev (standing)");
  expect(linesFromPlan({ ops: [{ ...plan.ops[0]!, status: "failed", error: "e" }] })).toEqual([{ id: "o1", label: "Copy a.md", status: "failed", error: "e" }]);
});

test("needsDirector: only when the import did not start a director", () => {
  const withDir: ImportPlan = { ...plan, ops: [...plan.ops, { id: "o6", item: "agent:boss", op: "create-agent", agent: { name: "boss", director: true } }, { id: "o7", item: "agent:boss", op: "start-agent", name: "boss" }] };
  const done = withDir.ops.map((o) => ({ id: o.id, label: "", status: "done" as const }));
  expect(importedDirector(withDir, done)).toBe("boss");
  expect(needsDirector(withDir, done)).toBe(false);
  expect(needsDirector(withDir, done.map((x) => (x.id === "o7" ? { ...x, status: "failed" as const } : x)))).toBe(true);
  expect(needsDirector(plan, done)).toBe(true);
  expect(needsDirector(null, [])).toBe(true);
  expect(importedDirector({ ops: withDir.ops.map((o) => (o.id === "o7" ? { ...o, status: "ok" as const } : o)) }, [])).toBe("boss");
});
