import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-schema-"));
delete process.env.TRAILS_DEFAULT_REPO;
const { Database } = await import("bun:sqlite");
const { useDatabase, db } = await import("../core/db");
const st = await import("./store");
const rt = await import("./routes");

const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
beforeAll(() => { useDatabase(new Database(":memory:")); st._reset(); });

describe("token_file, kind, revoked_tokens", () => {
  test("createAgent stores token_file and kind", () => {
    const m = rt.createAgent({ name: "t-1", by: "root" });
    const row = db().query("SELECT token_file, kind FROM agents WHERE name = 't-1'").get() as { token_file: string; kind: string };
    expect(row.token_file).toBe(m.tokenFile); expect(row.kind).toBe("agent");
  });
  for (const kind of ["agent", "member"] as const) {
    test(`retireAgent despawn, kind ${kind}: ${kind === "agent" ? "kills once" : "never kills"}, deletes file, revokes`, () => {
      const m = rt.createAgent({ name: `r-${kind}`, by: "root", kind });
      const row = rt.byName(`r-${kind}`)!;
      let kills = 0;
      rt.retireAgent(row, "despawn", Date.now(), () => { kills++; });
      expect(kills).toBe(kind === "agent" ? 1 : 0);
      expect(existsSync(m.tokenFile)).toBe(false);
      expect(db().query("SELECT 1 FROM revoked_tokens WHERE hash = ?").get(sha(m.token))).toBeTruthy();
      expect(rt.isRevoked(m.token)).toBe(true);
    });
  }
});

describe("root session name", () => {
  test("default and env override", async () => {
    delete process.env.AGENTNET_ROOT_SESSION;
    const w = await import("./windows");
    expect(w.isAgentSession("agentnet-root")).toBe(false);
    expect(w.isAgentSession("agentnet-a-1")).toBe(true);
    expect(w.sessionOf("root")).toBe("agentnet-root");
    process.env.AGENTNET_ROOT_SESSION = "main";
    const w2 = await import(`./windows?x=${1}` as string) as typeof w;
    expect(w2.sessionOf("root")).toBe("main");
    expect(w2.isAgentSession("main")).toBe(false);
    delete process.env.AGENTNET_ROOT_SESSION;
  });
});

describe("trails", () => {
  test("repos default empty", async () => {
    const { trailConfig } = await import("./trails");
    expect(trailConfig().repos).toEqual([]);
  });
});
