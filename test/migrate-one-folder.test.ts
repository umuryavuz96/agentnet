// agentnet migrate one-folder (docs/internal/one-folder/SPEC-step6-migration.md). The spec names test/migrate.test.ts; that file
// already holds the Server OS migration, so these live here. Every store is a temp folder shaped like the old layout.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-onefolder-"));
const { Database } = await import("bun:sqlite");
const { db, useDatabase } = await import("../src/core/db");
const st = await import("../src/net/store");
const rt = await import("../src/net/routes");
const fin = await import("../src/net/finish");
const mg = await import("../src/net/migrate");
const layout = await import("../src/core/layout");
const { ROOT: HOME } = await import("../src/core/config"); // the home the server modules write to: the first test file in this process fixed it
const { promptPath } = await import("../src/net/director");

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
/** Every file under d with its sha256 and mode, except the DB (its bytes change on any write) and backups/. */
const snap = (d: string, base = d): Record<string, string> => Object.assign({}, ...readdirSync(d, { withFileTypes: true }).map((e) => {
  const p = join(d, e.name), r = p.slice(base.length);
  if (r.startsWith("/data") || r.startsWith("/backups")) return {};
  return e.isDirectory() ? { [r + "/"]: (statSync(p).mode & 0o777).toString(8), ...snap(p, base) } : { [r]: `${sha(p)} ${(statSync(p).mode & 0o777).toString(8)}` };
}));
const tokenFiles = (d: InstanceType<typeof Database>) => Object.fromEntries((d.query("SELECT id, token_file FROM agents").all() as { id: string; token_file: string }[]).map((r) => [r.id, r.token_file]));

/** A store in the old layout: tokens in run/agentnet, souls in run/souls, records in records/<name>. */
function makeStore(running: { live?: string; standing?: string; env?: string; open?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "an-of-store-"));
  mkdirSync(join(root, "data"), { recursive: true });
  const d = new Database(join(root, "data", "agentnet.db"), { create: true });
  useDatabase(d); st._reset();
  const tokens: Record<string, string> = {};
  const legacy = (name: string, id: string) => { // put the token where the old code wrote it
    const from = join(HOME, "agents", name, "token"), to = join(root, "run", "agentnet", `${name}.token`);
    mkdirSync(join(root, "run", "agentnet"), { recursive: true, mode: 0o700 });
    renameSync(from, to); rmdirSync(join(HOME, "agents", name));
    d.run("UPDATE agents SET token_file = ? WHERE id = ?", [to, id]);
  };
  for (const name of ["stop-a", "stop-b", "stop-c", "live-1", "stand-1", "env-1", "open-1"]) {
    const a = rt.createAgent({ name, job: "t", by: "test", standing: name === (running.standing ?? "stand-1") });
    tokens[name] = a.token; legacy(name, a.id);
    if (name !== (running.live ?? "live-1")) st.emit({ agent: a.id, type: "AgentGone", data: { reason: "test" }, source: "service", ts: Date.now() });
  }
  st.flush();
  for (const [f, v] of [["run/root.token", "R"], ["run/panel.token", "P"], ["run/agentnet/root.token", "R2"], ["run/agentnet/open-x.command", "#!/bin/sh"], ["run/server-launch.json", "{}"],
    ["run/souls/agentnet-stop-a.md", "soul a"], ["run/souls/agentnet-director.md", "director"], ["records/stop-a/handover-1.md", "h1"], ["records/stop-b/handover-2.md", "h2"]] as const) {
    mkdirSync(join(root, f, ".."), { recursive: true, mode: 0o700 }); writeFileSync(join(root, f), v, { mode: 0o600 });
  }
  const procs: import("../src/net/migrate").MigrateProcs = {
    envTokenFiles: () => [join(root, "run", "agentnet", `${running.env ?? "env-1"}.token`)],
    isOpen: (f) => f === join(root, "run", "agentnet", `${running.open ?? "open-1"}.token`),
  };
  return { root, d, tokens, procs };
}

describe("migrate one-folder", () => {
  test("migrate: dry run writes nothing and lists every move and skip", () => {
    const s = makeStore(), before = snap(s.root), dbBefore = tokenFiles(s.d);
    const p = mg.planMigration(s.root, s.d, s.procs), lines = mg.formatPlan(p).join("\n");
    expect(snap(s.root)).toEqual(before); expect(tokenFiles(s.d)).toEqual(dbBefore);
    expect(p.moves.filter((m) => m.kind === "token").map((m) => m.from.split("/").pop()).sort()).toEqual(["stop-a.token", "stop-b.token", "stop-c.token"]);
    expect(lines).toContain("move token  run/agentnet/stop-a.token -> agents/stop-a/token");
    expect(lines).toContain("copy soul  run/souls/agentnet-director.md -> souls/agentnet-director.md");
    expect(lines).toContain("move record  records/stop-b/handover-2.md -> agents/stop-b/records/handover-2.md");
    for (const n of ["live-1", "stand-1", "env-1", "open-1"]) expect(lines).toContain(`skipped: run/agentnet/${n}.token  running (`);
    expect(lines).toContain("left: run/agentnet/open-x.command  not a token");
    expect(lines).toMatch(/total: 3 tokens, 2 souls, 2 records to move; 4 skipped, 2 left/);
  });

  test("migrate: apply moves tokens, souls and records of stopped agents and updates token_file", () => {
    const s = makeStore(), r = mg.applyMigration(s.root, s.procs);
    expect(r.manifest).not.toBeNull();
    const man = JSON.parse(readFileSync(join(s.root, "backups", `migrate-${r.manifest!.id}`, "manifest.json"), "utf8"));
    expect(man.moves.length).toBe(7); expect(existsSync(man.dbBackup)).toBe(true);
    for (const n of ["stop-a", "stop-b", "stop-c"]) {
      const f = join(s.root, "agents", n, "token");
      expect(readFileSync(f, "utf8")).toBe(s.tokens[n]!); expect(statSync(f).mode & 0o777).toBe(0o600); expect(statSync(join(s.root, "agents", n)).mode & 0o777).toBe(0o700);
      expect(existsSync(join(s.root, "run", "agentnet", `${n}.token`))).toBe(false);
      expect(rt.byName(n)!.token_file).toBe(f);
      expect(rt.agentByToken(s.tokens[n]!)?.name).toBe(n); // auth is by value: unchanged
    }
    expect(readFileSync(join(s.root, "souls", "agentnet-stop-a.md"), "utf8")).toBe("soul a");
    expect(existsSync(join(s.root, "run", "souls", "agentnet-stop-a.md"))).toBe(true); // copied, not moved
    expect(readFileSync(join(s.root, "agents", "stop-b", "records", "handover-2.md"), "utf8")).toBe("h2");
    expect(existsSync(join(s.root, "records", "stop-b"))).toBe(false);
  });

  test("migrate: copied store with token_file pointing at another home never touches that home", () => {
    const live = makeStore(), copy = mkdtempSync(join(tmpdir(), "an-of-copy-"));
    Bun.spawnSync(["rsync", "-a", live.root + "/", copy + "/"]); // the copy's rows still name the live home's files
    const liveBefore = snap(live.root), liveDb = sha(join(live.root, "data", "agentnet.db"));
    const d = new Database(join(copy, "data", "agentnet.db"), { readwrite: true });
    const copied = tokenFiles(d);
    expect(Object.values(copied).filter((f) => f?.startsWith(live.root + "/")).length).toBe(7);
    const r = mg.applyMigration(copy, live.procs); // the live processes name live files: on the copy env-1 and open-1 count as stopped
    expect(r.plan.moves.filter((m) => m.kind === "token").length).toBe(5);
    for (const m of r.plan.moves) { expect(m.from.startsWith(copy + "/")).toBe(true); expect(m.to.startsWith(copy + "/")).toBe(true); }
    expect((d.query("SELECT token_file FROM agents WHERE name = 'stop-a' AND archived_at IS NULL").get() as { token_file: string }).token_file).toBe(join(copy, "agents", "stop-a", "token"));
    expect(mg.undoMigration(copy, r.manifest!.id).ok).toBe(true);
    expect(tokenFiles(d)).toEqual(copied); // the old token_file values, as copied
    expect(snap(live.root)).toEqual(liveBefore); expect(sha(join(live.root, "data", "agentnet.db"))).toBe(liveDb);
    d.close();
  });

  test("migrate: running agent token is not moved and still authenticates (live row, standing, env, open file)", () => {
    for (const why of ["live row", "standing", "AGENTNET_TOKEN_FILE in a process env", "file is open"]) {
      // only one agent running, by one rule; the others are stopped
      const one = why === "live row" ? { live: "env-1", standing: "none", env: "none", open: "none" } : why === "standing" ? { live: "none", standing: "env-1", env: "none", open: "none" }
        : why.startsWith("AGENTNET") ? { live: "none", standing: "none", env: "env-1", open: "none" } : { live: "none", standing: "none", env: "none", open: "env-1" };
      const s = makeStore(one), r = mg.applyMigration(s.root, s.procs);
      const f = join(s.root, "run", "agentnet", "env-1.token");
      expect(r.plan.skips).toContainEqual({ path: f, reason: `running (${why}), moves on respawn` });
      expect(r.plan.moves.filter((m) => m.kind === "token").length).toBe(6);
      expect(readFileSync(f, "utf8")).toBe(s.tokens["env-1"]!); expect(rt.byName("env-1")!.token_file).toBe(f);
      expect(rt.agentByToken(readFileSync(f, "utf8"))?.name).toBe("env-1");
    }
  });

  test("migrate: second apply moves nothing", () => {
    const s = makeStore();
    expect(mg.applyMigration(s.root, s.procs).manifest).not.toBeNull();
    const again = mg.applyMigration(s.root, s.procs);
    expect(again.manifest).toBeNull(); expect(again.plan.moves).toEqual([]);
    expect(readdirSync(join(s.root, "backups")).length).toBe(1);
  });

  test("migrate: undo restores the store byte for byte and refuses on a changed file", () => {
    const s = makeStore(), before = snap(s.root), dbBefore = tokenFiles(s.d);
    const id = mg.applyMigration(s.root, s.procs).manifest!.id;
    expect(snap(s.root)).not.toEqual(before);
    const u = mg.undoMigration(s.root, id);
    expect(u.ok).toBe(true); expect(u.checked).toBe(7);
    expect(snap(s.root)).toEqual(before); expect(tokenFiles(s.d)).toEqual(dbBefore);
    // a spawn wrote into souls/ after the migration: the soul copies stay so souls/ still holds the director prompt
    const id3 = mg.applyMigration(s.root, s.procs).manifest!.id;
    writeFileSync(join(s.root, "souls", "agentnet-new-1.md"), "new soul");
    const u3 = mg.undoMigration(s.root, id3);
    expect(u3.ok).toBe(true); expect(u3.kept[0]).toContain("kept 2 soul copies");
    expect(existsSync(join(s.root, "souls", "agentnet-director.md"))).toBe(true); expect(existsSync(join(s.root, "run", "souls", "agentnet-director.md"))).toBe(true);
    rmSync(join(s.root, "souls"), { recursive: true });
    // changed after the move: refused, nothing touched; --force goes ahead
    const id2 = mg.applyMigration(s.root, s.procs).manifest!.id;
    writeFileSync(join(s.root, "agents", "stop-a", "token"), "changed");
    const mid = snap(s.root), refused = mg.undoMigration(s.root, id2);
    expect(refused.ok).toBe(false); expect(refused.refused[0]).toContain("agents/stop-a/token: changed since the migration"); expect(snap(s.root)).toEqual(mid);
    const forced = mg.undoMigration(s.root, id2, true);
    expect(forced.restored.length).toBe(7); expect(forced.ok).toBe(false); expect(forced.checked).toBe(6);
  });

  test("migrate: root and panel tokens and unknown files are never moved", () => {
    const s = makeStore(), keep = ["run/root.token", "run/panel.token", "run/agentnet/root.token", "run/agentnet/open-x.command", "run/server-launch.json"].map((f) => join(s.root, f));
    const shas = keep.map(sha), r = mg.applyMigration(s.root, s.procs);
    expect(keep.map(sha)).toEqual(shas);
    expect(r.plan.moves.some((m) => keep.includes(m.from))).toBe(false);
    expect(r.plan.left).toContainEqual({ path: join(s.root, "run", "agentnet", "root.token"), reason: "root token: never moved" });
    expect(existsSync(join(s.root, "agents", "root"))).toBe(false);
  });

  test("migrate: never creates claude/base/.complete or an agent config dir", () => {
    const s = makeStore(); mg.applyMigration(s.root, s.procs);
    expect(existsSync(join(s.root, "claude", "base", ".complete"))).toBe(false);
    for (const n of readdirSync(join(s.root, "agents"))) expect(existsSync(join(s.root, "agents", n, "claude"))).toBe(false);
  });
});

describe("paths", () => {
  test("paths: new spawn writes agents/<name>/token, retire removes it", () => {
    useDatabase(new Database(":memory:")); st._reset();
    const a = rt.createAgent({ name: "path-1", job: "t", by: "test" }), f = join(HOME, "agents", "path-1", "token");
    expect(a.tokenFile).toBe(f); expect(readFileSync(f, "utf8")).toBe(a.token);
    expect(statSync(f).mode & 0o777).toBe(0o600); expect(statSync(join(HOME, "agents", "path-1")).mode & 0o777).toBe(0o700);
    rt.retireAgent(rt.byName("path-1")!, "test", Date.now(), () => {});
    expect(existsSync(f)).toBe(false);
    const r = rt.createAgent({ name: "root", job: "t", by: "test" }); // root's token stays where house scripts read it
    expect(r.tokenFile).toBe(join(HOME, "run", "agentnet", "root.token")); expect(existsSync(join(HOME, "agents", "root"))).toBe(false);
  });

  test("paths: retire never unlinks a token_file outside the home", () => {
    const other = mkdtempSync(join(tmpdir(), "an-other-home-")), f = join(other, "out-1.token");
    writeFileSync(f, "live token", { mode: 0o600 });
    rt.createAgent({ name: "out-1", job: "t", by: "test" });
    db().run("UPDATE agents SET token_file = ? WHERE name = 'out-1' AND archived_at IS NULL", [f]);
    rt.retireAgent(rt.byName("out-1")!, "despawn", Date.now(), () => {});
    expect(readFileSync(f, "utf8")).toBe("live token");
    expect(rt.byName("out-1")).toBeNull(); // the row is still retired
  });

  test("paths: handoverFor reads new and old records dirs, newest wins", () => {
    const old = layout.legacyRecordsDir("hand-1", HOME), neu = layout.agentRecordsDir("hand-1", HOME);
    mkdirSync(old, { recursive: true }); writeFileSync(join(old, "handover-3.md"), "old gen 3");
    expect(fin.handoverFor("hand-1")).toBe("old gen 3");
    mkdirSync(neu, { recursive: true }); writeFileSync(join(neu, "handover-2.md"), "new gen 2");
    expect(fin.handoverFor("hand-1")).toBe("old gen 3");
    writeFileSync(join(neu, "handover-4.md"), "new gen 4");
    expect(fin.handoverFor("hand-1")).toBe("new gen 4");
    expect(fin.recordsDir("hand-1")).toBe(neu);
  });

  test("paths: souls() falls back to run/souls until souls/ exists", () => {
    const root = mkdtempSync(join(tmpdir(), "an-souls-"));
    expect(layout.soulsDir(root)).toBe(join(root, "run", "souls"));
    expect(promptPath("adopt", root)).toBe(join(root, "run", "souls", "agentnet-director.md"));
    mkdirSync(join(root, "souls")); chmodSync(join(root, "souls"), 0o700);
    expect(layout.soulsDir(root)).toBe(join(root, "souls"));
    expect(promptPath("scan", root)).toBe(join(root, "souls", "agentnet-director-scan.md"));
  });
});

