import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import type { Env } from "../core/http";
import { LAN, LOOP } from "../../test/helpers";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-bgjobs-"));
const { safeFile, tailLines, listOutputs, progressOf, kindOf, jobDetail, bgjobRoutes } = await import("./bgjobs");
const tmp = () => mkdtempSync(join(tmpdir(), "bgw-"));
function fixture() {
  const root = tmp(), outside = tmp(), out = join(root, "out");
  mkdirSync(join(out, "sub"), { recursive: true });
  writeFileSync(join(out, "a.png"), "png"); writeFileSync(join(out, "sub", "b.json"), "{}"); writeFileSync(join(out, ".env"), "SECRET=1");
  writeFileSync(join(outside, "secret.txt"), "nope");
  symlinkSync(join(outside, "secret.txt"), join(out, "link.txt")); symlinkSync(outside, join(out, "dirlink"));
  return { root, out, outside };
}

test("path guard: inside files are served; .., absolute, dotfiles, symlink escapes, missing files and bad input are not", () => {
  const { out, outside } = fixture();
  expect(safeFile([out], "a.png")).toMatchObject({ mime: "image/png", size: 3 });
  expect(safeFile([out], "sub/b.json")).not.toBeNull();
  for (const bad of ["../x", "sub/../../x", join(outside, "secret.txt"), ".env", "sub/.hidden", "link.txt", "dirlink/secret.txt", "nope.png", "", "a\0.png", "sub"]) expect(safeFile([out], bad)).toBeNull();
  expect(safeFile([], "a.png")).toBeNull();
});
test("size cap: oversize files are refused", () => {
  const { out } = fixture(); const big = join(out, "big.bin");
  writeFileSync(big, Buffer.alloc(26 * 1024 * 1024));
  expect(safeFile([out], "big.bin")).toBeNull();
});
test("outputs are newest first, skip dotfiles, kinds by extension", () => {
  const { out } = fixture();
  utimesSync(join(out, "a.png"), 1000, 1000); utimesSync(join(out, "sub", "b.json"), 2000, 2000);
  const r = listOutputs([out]);
  expect(r.files.map((f) => f.path).slice(0, 2)).toEqual(["sub/b.json", "a.png"]);
  expect(r.files.some((f) => f.name === ".env")).toBe(false);
  expect([kindOf("x.GIF"), kindOf("a.mp4"), kindOf("a.csv"), kindOf("a.pdf"), kindOf("a.bin")]).toEqual(["image", "video", "csv", "pdf", "other"]);
});
test("log tail returns the last lines only", () => {
  const d = tmp(), f = join(d, "l.log"); writeFileSync(f, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n");
  const t = tailLines(f, 30); expect(t).toHaveLength(30); expect(t.at(-1)).toBe("line 99"); expect(tailLines(join(d, "none"))).toEqual([]);
});
test("progress: JSON file, lines against a total, outputs against a total, none", () => {
  const d = tmp(); writeFileSync(join(d, "p.json"), JSON.stringify({ done: 3, total: 10, label: "x" })); writeFileSync(join(d, "run.jsonl"), "a\nb\nc\n\n");
  const base = { id: "i", owner: null, pid: 1, desc: "d", started: 0 };
  expect(progressOf({ ...base, progress: { file: join(d, "p.json") } }, 0)).toEqual({ done: 3, total: 10, label: "x" });
  expect(progressOf({ ...base, progress: { file: join(d, "run.jsonl"), lines: true, total: 87 } }, 0)).toEqual({ done: 3, total: 87, label: null });
  expect(progressOf({ ...base, total: 20 }, 5)).toEqual({ done: 5, total: 20, label: null });
  expect(progressOf(base, 5)).toBeNull();
});
test("job detail: status from exit file, ids are validated", () => {
  const { root, out } = fixture(); process.env.AGENTNET_BGJOBS = join(root, "bgjobs"); mkdirSync(join(root, "bgjobs"));
  writeFileSync(join(root, "bgjobs", "j1.json"), JSON.stringify({ id: "j1", owner: "t/a", pid: 999999, desc: "d", started: Date.now(), outputs: [out] }));
  expect(jobDetail("j1")).toMatchObject({ status: "stopped", hasOutputs: true, outputCount: 2 });
  writeFileSync(join(root, "bgjobs", "j1.exit"), "0"); expect(jobDetail("j1")!.status).toBe("done");
  writeFileSync(join(root, "bgjobs", "j1.exit"), "2"); expect(jobDetail("j1")!.status).toBe("failed");
  expect(jobDetail("../etc/passwd")).toBeNull(); expect(jobDetail("nope")).toBeNull();
});

test("routes: list, detail, file, missing", async () => {
  const { root, out } = fixture(); const folder = join(root, "bgjobs"); process.env.AGENTNET_BGJOBS = folder; mkdirSync(folder);
  writeFileSync(join(folder, "j2.json"), JSON.stringify({ id: "j2", owner: null, pid: 999999, desc: "d", started: Date.now(), outputs: [out] }));
  const api = new Hono<Env>(); bgjobRoutes(api);
  expect(((await (await api.request("/bgjobs")).json()) as { id: string }[]).map((j) => j.id)).toEqual(["j2"]);
  expect((await api.request("/bgjobs/j2")).status).toBe(200);
  expect((await api.request("/bgjobs/nope")).status).toBe(404);
  const f = await api.request("/bgjobs/j2/file?path=a.png", {}, LOOP);
  expect(f.status).toBe(200); expect(f.headers.get("content-type")).toBe("image/png");
  expect((await api.request("/bgjobs/j2/file?path=../x", {}, LOOP)).status).toBe(404);
});

test("output file route is root only: forwarded or LAN peers get 403, loopback root gets the file", async () => {
  const { out } = fixture(); const bg = tmp(); process.env.AGENTNET_BGJOBS = bg;
  writeFileSync(join(bg, "j1.json"), JSON.stringify({ id: "j1", desc: "x", started: 1, outputs: [out] }));
  const api = new Hono<Env>(); bgjobRoutes(api); const a = new Hono<Env>(); a.route("/api/v1", api);
  const u = "/api/v1/bgjobs/j1/file?path=a.png";
  expect((await a.request(u, { headers: { "X-Forwarded-For": "10.0.0.5" } }, LOOP)).status).toBe(403);
  expect((await a.request(u, {}, LAN)).status).toBe(403);
  const ok = await a.request(u, {}, LOOP);
  expect(ok.status).toBe(200); expect(await ok.text()).toBe("png");
  delete process.env.AGENTNET_BGJOBS;
});
