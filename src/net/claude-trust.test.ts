import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpJsonServers, preAnswerProject } from "./claude-trust";

function fx() {
  const t = mkdtempSync(join(tmpdir(), "an-trust-")), home = join(t, "home"), proj = join(home, "projects", "money-map");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(home, ".mcp.json"), JSON.stringify({ mcpServers: { playwright: { command: "p" }, posthog: { command: "q" }, gaspedaal: { command: "r" } } }));
  const file = join(t, "claude.json");
  writeFileSync(file, JSON.stringify({ numStartups: 3, projects: { "/other": { hasTrustDialogAccepted: true } } }, null, 2) + "\n");
  return { t, home, proj, file, backupDir: join(t, "bak") };
}

test("servers come from .mcp.json files of the folder and every parent", () => {
  const { home, proj } = fx();
  writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { local: {} } }));
  expect(mcpJsonServers(proj).sort()).toEqual(["gaspedaal", "local", "playwright", "posthog"]);
  expect(home).toBeTruthy();
});

test("trust is accepted, playwright is enabled, every other server is disabled, the rest of the file is untouched", () => {
  const { proj, file, backupDir } = fx();
  const r = preAnswerProject(proj, { file, backupDir });
  expect(r.error).toBeUndefined();
  expect(r.enabled).toEqual(["playwright"]); expect(r.disabled.sort()).toEqual(["gaspedaal", "posthog"]);
  const j = JSON.parse(readFileSync(file, "utf8"));
  const e = j.projects[proj];
  expect(e.hasTrustDialogAccepted).toBe(true);
  expect(e.enabledMcpjsonServers).toEqual(["playwright"]);
  expect([...e.disabledMcpjsonServers].sort()).toEqual(["gaspedaal", "posthog"]);
  expect(j.numStartups).toBe(3); expect(j.projects["/other"]).toEqual({ hasTrustDialogAccepted: true });
  expect(readdirSync(backupDir).length).toBe(1); // backup of the old file
  expect(readdirSync(join(file, "..")).some((n) => n.endsWith(".tmp"))).toBe(false); // temp file renamed away
});

test("a second run changes nothing; earlier answers win; --enable picks the servers", () => {
  const { proj, file, backupDir } = fx();
  preAnswerProject(proj, { file, backupDir });
  expect(preAnswerProject(proj, { file, backupDir }).changed).toEqual([]);
  const j = JSON.parse(readFileSync(file, "utf8")); j.projects[proj].disabledMcpjsonServers = ["gaspedaal", "posthog", "playwright"]; j.projects[proj].enabledMcpjsonServers = []; writeFileSync(file, JSON.stringify(j));
  expect(preAnswerProject(proj, { file, backupDir, enable: ["posthog"] }).changed).toEqual([]); // already answered: kept
  const p2 = join(proj, "sub"); mkdirSync(p2);
  const r = preAnswerProject(p2, { file, backupDir, enable: ["posthog", "gaspedaal"] });
  expect(r.enabled.sort()).toEqual(["gaspedaal", "posthog"]); expect(r.disabled).toEqual(["playwright"]);
});

test("a missing or broken config file is left alone", () => {
  const { proj, t } = fx();
  expect(preAnswerProject(proj, { file: join(t, "nope.json") }).changed).toEqual([]);
  const bad = join(t, "bad.json"); writeFileSync(bad, "{ not json");
  expect(preAnswerProject(proj, { file: bad, backupDir: join(t, "b") }).error).toBeTruthy();
  expect(readFileSync(bad, "utf8")).toBe("{ not json");
});
