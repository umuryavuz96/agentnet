import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fake Server OS var folder: data/server-os.db with the agentnet DDL + one unrelated Server OS table (devices), 3 agents, 50 events,
 *  10 messages, 1 team with 2 members and 1 task, data/agent-scores.db with 2 rows, data/trails.db, trails/a.md + trails/b.md (mtime 2026-01-01),
 *  config/model-routing.json, config/server-os.yaml, data/admin.key, run/agentnet/a-1.token, a data/cass symlink to a temp folder.
 *  Built through the real code, then stripped of the agentnet-only columns a Server OS file never had.
 *  AGENTNET_HOME must be set to a temp folder before this module is imported. */
export async function makeServerOsVar(): Promise<{ dir: string; agents: string[]; cassTarget: string }> {
  const { useDatabase } = await import("../src/core/db");
  const store = await import("../src/net/store");
  const routes = await import("../src/net/routes");
  const teams = await import("../src/net/teams");

  const dir = mkdtempSync(join(tmpdir(), "an-serveros-var-"));
  for (const d of ["data", "config", "trails", "run/agentnet"]) mkdirSync(join(dir, d), { recursive: true });
  const d = new Database(join(dir, "data", "server-os.db"), { create: true });
  useDatabase(d); store._reset(); store.ensureSchema();

  const T0 = 1_700_000_000_000;
  for (const name of ["a-1", "a-2", "root"]) routes.createAgent({ name, job: "fixture", boss: "root", by: "root" }, T0);
  const a1 = routes.byName("a-1")!, a2 = routes.byName("a-2")!;
  store.emit({ agent: a1.id, type: "AgentConnected", data: { session: "s1", pid: 4242, version: "2.1.0" }, source: "mod", ts: T0 + 1 });
  store.flush();
  for (let i = 0; i < 5; i++) {
    routes.enqueueMessage(a1, a2, `hello ${i}`, "info", null, undefined, T0 + 10 + i);
    routes.enqueueMessage(a2, a1, `reply ${i}`, "info", null, undefined, T0 + 20 + i);
  }
  store.flush();
  let n = 0;
  while (store.lastSeq() < 50) {
    const turn = `t${n++}`;
    store.emit({ agent: a1.id, type: "TurnStarted", data: { turn, snippet: "work" }, source: "mod", ts: T0 + 100 + n * 2 });
    store.emit({ agent: a1.id, type: "TurnEnded", data: { reason: "answer" }, source: "mod", ts: T0 + 101 + n * 2 });
    store.flush();
  }
  const team = teams.createTeam({ name: "Crew", id: "crew", members: ["a-1", "a-2"] }, T0);
  teams.addTeamTask(team.id, "do the thing", "a-1", T0);
  store.flush();

  // Make it look like a Server OS-era file.
  d.run("ALTER TABLE agents DROP COLUMN token_file");
  d.run("ALTER TABLE agents DROP COLUMN kind");
  d.run("DROP TABLE revoked_tokens");
  d.run("CREATE TABLE devices (id TEXT PRIMARY KEY)");
  d.run("INSERT INTO devices (id) VALUES ('tv')");
  d.run("UPDATE sqlite_sequence SET seq = 99 WHERE name = 'messages'");
  d.close();
  store._reset();

  // Scores: the old column name (umur_rounds), as in a Server OS file.
  const s = new Database(join(dir, "data", "agent-scores.db"), { create: true });
  s.run("PRAGMA journal_mode = WAL");
  s.run(`CREATE TABLE agent_scores (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, agent_id TEXT NOT NULL, role TEXT NOT NULL, model TEXT, soul TEXT, project TEXT,
    task_id INTEGER NOT NULL, text TEXT NOT NULL, started_at INTEGER, done_at INTEGER NOT NULL, tokens INTEGER, cost_usd REAL, cost_settled INTEGER NOT NULL DEFAULT 0,
    listed_first INTEGER NOT NULL DEFAULT 0, prompt_start INTEGER NOT NULL DEFAULT 0, prompt_done INTEGER NOT NULL DEFAULT 0, note_filled INTEGER NOT NULL DEFAULT 0,
    grade INTEGER, note TEXT, rework INTEGER NOT NULL DEFAULT 0, rework_at INTEGER, umur_rounds INTEGER, graded_at INTEGER, UNIQUE (agent_id, task_id))`);
  s.run("CREATE INDEX agent_scores_agent ON agent_scores (agent, done_at)");
  s.run("INSERT INTO agent_scores (agent, agent_id, role, task_id, text, done_at, grade, umur_rounds) VALUES ('a-1','a-1#1','backend',1,'one',?,5,2)", [T0 + 200]);
  s.run("INSERT INTO agent_scores (agent, agent_id, role, task_id, text, done_at) VALUES ('a-2','a-2#1','backend',1,'two',?)", [T0 + 300]);
  s.close();

  // Trails index (FTS5) and notes.
  const t = new Database(join(dir, "data", "trails.db"), { create: true });
  t.run("PRAGMA journal_mode = WAL");
  t.run(`CREATE VIRTUAL TABLE trail_fts USING fts5(id UNINDEXED, kind UNINDEXED, repo UNINDEXED, date UNINDEXED, agent UNINDEXED,
    checkpoint UNINDEXED, commit_sha UNINDEXED, title, files, body, tokenize = 'porter unicode61')`);
  t.run("CREATE TABLE trail_src (id TEXT PRIMARY KEY, key TEXT NOT NULL)");
  t.run("INSERT INTO trail_fts (id, kind, title, files, body) VALUES ('n1', 'note', 'a note', '', 'body text')");
  t.close();
  const old = new Date("2026-01-01T00:00:00Z");
  for (const f of ["a.md", "b.md"]) { writeFileSync(join(dir, "trails", f), `# ${f}\n`); utimesSync(join(dir, "trails", f), old, old); }

  writeFileSync(join(dir, "config", "model-routing.json"), "{}\n");
  writeFileSync(join(dir, "config", "server-os.yaml"), "auth: off\n");
  writeFileSync(join(dir, "data", "admin.key"), "secret\n");
  writeFileSync(join(dir, "run", "agentnet", "a-1.token"), "tok\n");
  const cassTarget = mkdtempSync(join(tmpdir(), "an-cass-"));
  symlinkSync(cassTarget, join(dir, "data", "cass"));
  return { dir, agents: ["a-1", "a-2", "root"], cassTarget };
}
