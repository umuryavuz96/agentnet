import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-migrate-"));
const { Database } = await import("bun:sqlite");
const { useDatabase } = await import("../src/core/db");
const store = await import("../src/net/store");
const routes = await import("../src/net/routes");
const { migrate, verifyFold } = await import("../src/migrate/fromServerOs");
const { exportLegacy } = await import("../src/migrate/exportLegacy");
const { makeServerOsVar } = await import("./migrateFixture");

const fresh = (p = "an-target-") => mkdtempSync(join(tmpdir(), p));
// A zero-byte file counts as absent: on Linux even a read-only SQLite open (the q() helper below) leaves empty -wal/-shm sidecars; they hold no data.
const sha = (f: string) => (existsSync(f) && statSync(f).size > 0 ? createHash("sha256").update(readFileSync(f)).digest("hex") : "-");
const tree = (d: string, base = d): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = join(d, e.name);
  return e.isDirectory() ? tree(p, base) : /-shm$/.test(e.name) || (/-wal$/.test(e.name) && statSync(p).size === 0) ? [] : [p.slice(base.length)];
}).sort();
const q = <T>(file: string, sql: string, ...a: (string | number)[]): T[] => {
  const d = new Database(file, { readonly: true });
  try { return d.query(sql).all(...a) as T[]; } finally { d.close(); }
};

const fx = await makeServerOsVar();
const srcDb = join(fx.dir, "data", "server-os.db");
const members = ["root"];

describe("migrate-from-server-os", () => {
  const to = fresh();
  const before = { db: sha(srcDb), wal: sha(srcDb + "-wal"), tree: tree(fx.dir) };
  const r = migrate({ source: fx.dir, to, dryRun: true, members });

  test("1 counts, fold and marks", () => {
    expect(r.ok).toBe(true);
    for (const t of ["agents", "agent_events", "agent_status", "messages", "teams", "team_members", "team_tasks"]) {
      expect(r.counts[t]!.source).toBe(r.counts[t]!.target);
    }
    expect(r.counts.agents).toEqual({ source: 3, target: 3 });
    expect(r.counts.agent_scores).toEqual({ source: 2, target: 2 });
    expect(r.counts.trails).toEqual({ source: 2, target: 2 });
    expect(r.fold.differ).toEqual([]);
    const marks = JSON.parse(readFileSync(join(to, "data", "migrated-from.json"), "utf8"));
    const srcMax = q<{ m: number }>(srcDb, "SELECT MAX(seq) AS m FROM agent_events")[0]!.m;
    expect(srcMax).toBeGreaterThanOrEqual(50);
    expect(marks.maxSeq).toBe(srcMax);
    expect(marks.maxMsgId).toBe(10);
    expect(marks.maxTeamTaskId).toBe(1);
  });

  test("2 member kind and token_file", () => {
    const rows = q<{ name: string; kind: string; token_file: string | null }>(join(to, "data", "agentnet.db"), "SELECT name, kind, token_file FROM agents");
    const by = Object.fromEntries(rows.map((x) => [x.name, x]));
    expect(by.root!.kind).toBe("member");
    expect(by["a-1"]!.kind).toBe("agent");
    expect(by["a-1"]!.token_file).toBe(join(fx.dir, "run", "agentnet", "a-1.token"));
    expect(by["a-2"]!.token_file).toBeNull();
  });

  test("3 sqlite_sequence follows the source", () => {
    const seq = q<{ seq: number }>(join(to, "data", "agentnet.db"), "SELECT seq FROM sqlite_sequence WHERE name = 'messages'")[0]!.seq;
    expect(seq).toBe(99);
  });

  test("4 what is not copied, cass link, mtimes, scores column rename", () => {
    expect(existsSync(join(to, "data", "admin.key"))).toBe(false);
    expect(existsSync(join(to, "config", "server-os.yaml"))).toBe(false);
    expect(readdirSync(join(to, "run", "agentnet"))).toEqual([]);
    expect(existsSync(join(to, "config", "model-routing.json"))).toBe(true);
    expect(lstatSync(join(to, "data", "cass")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(to, "data", "cass"))).toBe(fx.cassTarget);
    expect(statSync(join(to, "trails", "a.md")).mtimeMs).toBe(statSync(join(fx.dir, "trails", "a.md")).mtimeMs);
    expect(q(join(to, "data", "agent-scores.db"), "SELECT name FROM pragma_table_info('agent_scores')").map((c) => (c as { name: string }).name)).toContain("owner_rounds");
    expect(q<{ owner_rounds: number }>(join(to, "data", "agent-scores.db"), "SELECT owner_rounds FROM agent_scores WHERE id = 1")[0]!.owner_rounds).toBe(2);
    expect(q(join(to, "data", "agentnet.db"), "SELECT name FROM sqlite_master WHERE name = 'devices'")).toEqual([]);
  });

  test("5 source is unchanged", () => {
    expect(sha(srcDb)).toBe(before.db);
    expect(sha(srcDb + "-wal")).toBe(before.wal);
    expect(tree(fx.dir)).toEqual(before.tree);
  });

  test("6 second migrate into the same folder is refused", () => {
    expect(() => migrate({ source: fx.dir, to, dryRun: true, members })).toThrow("target already holds agents");
  });

  test("7 missing source database", () => {
    expect(() => migrate({ source: fresh(), to: fresh(), dryRun: true, members })).toThrow("no Server OS database at");
  });

  test("7b real run into the source folder is refused", () => {
    expect(() => migrate({ source: fx.dir, to: fx.dir, dryRun: false, members })).toThrow();
  });

  test("6b source === to is refused in a dry run too, and nothing is written into the source folder", () => {
    expect(() => migrate({ source: fx.dir, to: fx.dir, dryRun: true, members })).toThrow("same folder");
    expect(existsSync(join(fx.dir, "data", "agentnet.db"))).toBe(false);
  });

  test("8 fold check catches drift", () => {
    const d = new Database(join(to, "data", "agentnet.db"));
    try {
      expect(verifyFold(d).differ).toEqual([]);
      const row = d.query("SELECT agent_id, json FROM agent_status LIMIT 1").get() as { agent_id: string; json: string };
      d.run("UPDATE agent_status SET json = ? WHERE agent_id = ?", [JSON.stringify({ ...JSON.parse(row.json), state: "x" }), row.agent_id]);
      expect(verifyFold(d).differ).toEqual([row.agent_id]);
    } finally { d.close(); }
  });
});

describe("export-legacy (rollback)", () => {
  test("9 writes post-cutover rows back; dry run writes nothing", () => {
    const to2 = fresh("an-target2-");
    expect(migrate({ source: fx.dir, to: to2, dryRun: false, members }).ok).toBe(true);
    const eventsBefore = q<{ n: number }>(srcDb, "SELECT COUNT(*) AS n FROM agent_events")[0]!.n;

    // After the cutover agentnet is the active database.
    const d = new Database(join(to2, "data", "agentnet.db"));
    useDatabase(d); store._reset();
    const a1 = routes.byName("a-1")!, a2 = routes.byName("a-2")!;
    routes.enqueueMessage(a1, a2, "after 1", "info", null);
    routes.enqueueMessage(a2, a1, "after 2", "info", null);
    store._reset(); // drop the queued events: this test writes no events
    d.run("UPDATE messages SET state = 'read' WHERE id = 1");
    d.close();
    writeFileSync(join(to2, "trails", "c.md"), "# c\n");
    const sc = new Database(join(to2, "data", "agent-scores.db"));
    sc.run("UPDATE agent_scores SET owner_rounds = 7 WHERE id = 1");
    sc.close();

    const h = sha(srcDb);
    const dry = exportLegacy({ from: to2, to: fx.dir, yes: false });
    expect(dry.dryRun).toBe(true);
    expect(sha(srcDb)).toBe(h);
    expect(existsSync(join(fx.dir, "trails", "c.md"))).toBe(false);

    const done = exportLegacy({ from: to2, to: fx.dir, yes: true });
    expect(done.dryRun).toBe(false);
    expect(done.trails).toEqual(["c.md"]);
    expect(q<{ n: number }>(srcDb, "SELECT COUNT(*) AS n FROM messages")[0]!.n).toBe(12);
    expect(q<{ state: string }>(srcDb, "SELECT state FROM messages WHERE id = 1")[0]!.state).toBe("read");
    expect(q<{ n: number }>(srcDb, "SELECT COUNT(*) AS n FROM agent_events")[0]!.n).toBe(eventsBefore);
    expect(existsSync(join(fx.dir, "trails", "c.md"))).toBe(true);
    const cols = q<{ name: string }>(srcDb, "SELECT name FROM pragma_table_info('agents')").map((c) => c.name);
    expect(cols).not.toContain("kind");
    expect(cols).not.toContain("token_file");
    // The Server OS scores file still calls the column umur_rounds.
    expect(q<{ umur_rounds: number }>(join(fx.dir, "data", "agent-scores.db"), "SELECT umur_rounds FROM agent_scores WHERE id = 1")[0]!.umur_rounds).toBe(7);
  });

  test("9b no marks, nothing to roll back", () => {
    expect(() => exportLegacy({ from: fresh(), to: fx.dir, yes: true })).toThrow("no migration marks at");
  });
});

describe("AGENTNET_SWEEP=0", () => {
  test("11 reaper and liveness do nothing; the same calls work without the flag", async () => {
    process.env.AGENTNET_SWEEP = "0"; // bun test shares one process: restored in finally so other files see no flag
    const wn = await import("../src/net/windows");
    const lv = await import("../src/net/liveness");
    const calls: string[][] = [];
    const t = { run: (a: string[]) => { calls.push(a); return { code: 1, out: "" }; } };
    expect(wn.startSessionReaper(t, 0)).toBeUndefined();
    expect(calls).toEqual([]);

    const real = globalThis.setInterval;
    let made = 0;
    globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => { made++; return real(...a); }) as typeof setInterval;
    try {
      lv._reset(); lv.startLiveness();
      expect(made).toBe(0);
      delete process.env.AGENTNET_SWEEP;
      lv._reset(); lv.startLiveness();
      expect(made).toBe(1);
      const off = wn.startSessionReaper(t, 0);
      expect(typeof off).toBe("function");
      off!();
    } finally { globalThis.setInterval = real; lv._reset(); delete process.env.AGENTNET_SWEEP; }
  });
});

describe("cli", () => {
  const run = (...a: string[]) => {
    const p = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "..", "src", "cli.ts"), ...a], { env: { ...process.env, AGENTNET_HOME: fresh("an-clihome-"), AGENTNET_SWEEP: "0" } });
    return { code: p.exitCode, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
  };
  test("10 migrate dry run, usage errors, export without marks", () => {
    const ok = run("migrate-from-server-os", "--source", fx.dir, "--dry-run");
    expect(ok.code).toBe(0);
    const lines = ok.out.trim().split("\n");
    expect(lines[lines.length - 1]).toStartWith("migrate ok (dry run in ");
    expect(lines[lines.length - 2]).toStartWith("next: AGENTNET_HOME=");
    expect(lines[lines.length - 2]).toContain("AGENTNET_SWEEP=0 agentnet serve");
    expect(run("migrate-from-server-os").code).toBe(2);
    expect(run("migrate-from-server-os", "--source", fx.dir, "--dry-run", "--members", "Bad Name").code).toBe(2);
    const bad = run("export-legacy", "--to", fx.dir, "--from", fresh());
    expect(bad.code).toBe(1);
    expect(bad.err + bad.out).toContain("no migration marks");
  });
});
