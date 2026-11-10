import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedRead, denyReason, redactText, sha256File, writeAtomic } from "./adopt-safe";

let tmp = "", ws = "", oldHome: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "adopt-safe-"));
  oldHome = process.env.HOME; process.env.HOME = join(tmp, "home");
  ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true }); mkdirSync(join(tmp, "home/.ssh"), { recursive: true });
});
afterEach(() => { process.env.HOME = oldHome; rmSync(tmp, { recursive: true, force: true }); });
const put = (rel: string, body: string | Buffer, base = ws) => { const p = join(base, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); return p; };

test("normal file inside root is readable; outside is not", () => {
  expect(allowedRead(put("CLAUDE.md", "hi"), [ws])).toBe(true);
  expect(allowedRead(put("x.txt", "hi", tmp), [ws])).toBe(false);
  expect(denyReason(join(ws, "nope"), [ws])).toBe("path does not exist");
});
test("deny list names are blocked", () => {
  for (const n of [".env", ".env.local", "a.pem", "b.key", "c.p12", "id_rsa", "id_rsa.pub", "id_ed25519", "x.kdbx", "my-credentials.json", "client_secret.json", "api-token.txt"])
    expect(allowedRead(put(n, "x"), [ws])).toBe(false);
});
test("deny list home dirs and files are blocked even when the root covers them", () => {
  const h = process.env.HOME!;
  const p = put("id_x", "k", join(h, ".ssh")); expect(allowedRead(p, [h])).toBe(false);
  expect(allowedRead(put(".npmrc", "x", h), [h])).toBe(false);
  expect(allowedRead(put(".docker/config.json", "{}", h), [h])).toBe(false);
  expect(allowedRead(put(".aws/config", "x", h), [h])).toBe(false);
  expect(allowedRead(put(".claude/settings.json", "{}", h), [h])).toBe(true);
});
test("symlink out of the roots or onto a denied file is blocked", () => {
  const out = put("secret.txt", "x", tmp);
  symlinkSync(out, join(ws, "link.txt"));
  expect(allowedRead(join(ws, "link.txt"), [ws])).toBe(false);
  const env = put(".env", "TOKEN=1");
  symlinkSync(env, join(ws, "notes.txt"));
  expect(allowedRead(join(ws, "notes.txt"), [ws])).toBe(false);
  symlinkSync(join(tmp, "home/.ssh"), join(ws, "sshlink"));
  expect(allowedRead(join(ws, "sshlink/id_x"), [ws])).toBe(false);
});
test("dotdot escape is blocked", () => {
  put("a.txt", "x", tmp);
  expect(allowedRead(join(ws, "..", "a.txt"), [ws])).toBe(false);
});
test("size cap and binary are skipped", () => {
  expect(allowedRead(put("big.md", "a".repeat(200 * 1024 + 1)), [ws])).toBe(false);
  expect(allowedRead(put("ok.md", "a".repeat(200 * 1024)), [ws])).toBe(true);
  expect(allowedRead(put("bin.dat", Buffer.from([65, 0, 66])), [ws])).toBe(false);
});
test("redactText blanks secrets", () => {
  expect(redactText("TOKEN=abc123 ok")).toBe("TOKEN=*** ok");
  expect(redactText("Authorization: Bearer abc.def")).toBe("Authorization: ***");
  expect(redactText("curl -H 'x' Bearer zzz")).toContain("Bearer ***");
  expect(redactText("sha " + "a1b2c3d4".repeat(5))).toBe("sha ***");
  expect(redactText("plain words stay")).toBe("plain words stay");
});
test("redact copy in plugin stays identical", () => {
  const plugin = readFileSync(join(import.meta.dir, "../../plugin/hooks/register.ts"), "utf8").split("\n").find((l) => l.startsWith("const redact = "))!;
  const mine = readFileSync(join(import.meta.dir, "../core/redact.ts"), "utf8").split("\n").find((l) => l.startsWith("export const redact = "))!;
  expect(plugin.replace("const redact", "export const redact")).toBe(mine);
});
test("sha256File and writeAtomic", () => {
  const p = join(ws, "f.txt");
  writeAtomic(p, "hello\n", 0o600);
  expect(readFileSync(p, "utf8")).toBe("hello\n");
  expect(statSync(p).mode & 0o777).toBe(0o600);
  expect(sha256File(p)).toBe("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03");
  writeAtomic(p, "x", 0o644); expect(statSync(p).mode & 0o777).toBe(0o644);
  expect(readdirSync(ws).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});
