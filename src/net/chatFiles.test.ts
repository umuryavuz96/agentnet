import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEXT_MAX, readChatFile } from "./chatFiles";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
function fixture() {
  const out = mkdtempSync(join(tmpdir(), "chat-file-")), base = join(out, "proj"), other = join(out, "other");
  mkdirSync(join(base, "src"), { recursive: true }); mkdirSync(other);
  writeFileSync(join(base, "src", "a.ts"), "one\ntwo\nthree\nfour\n");
  writeFileSync(join(base, "shot.png"), PNG);
  writeFileSync(join(base, ".env"), "TOKEN=abc\n");
  writeFileSync(join(base, "notes.pem"), "x");
  writeFileSync(join(base, "app.sqlite"), "x");
  mkdirSync(join(base, "Library")); writeFileSync(join(base, "Library", "p.json"), "{}");
  mkdirSync(join(base, ".claude")); writeFileSync(join(base, ".claude", "s.json"), "{}");
  writeFileSync(join(base, "bin.json"), new Uint8Array([123, 0, 125]));
  writeFileSync(join(base, "fake.png"), "not a picture");
  writeFileSync(join(other, "secret.ts"), "leak\n");
  symlinkSync(join(other, "secret.ts"), join(base, "link.ts"));
  symlinkSync(other, join(base, "dir"));
  return { base, other };
}

describe("reading a file for the chat", () => {
  const { base, other } = fixture();
  test("a relative and an absolute path inside the project read; lines cut a range", () => {
    expect(readChatFile(base, "src/a.ts")).toMatchObject({ kind: "text", total: 4, from: 1, to: 4, text: "one\ntwo\nthree\nfour" });
    expect(readChatFile(base, join(base, "src/a.ts"), "2-3")).toMatchObject({ from: 2, to: 3, text: "two\nthree", total: 4 });
    expect(readChatFile(base, "src/a.ts", "9-12")).toMatchObject({ from: 4, to: 4 });
  });
  test("a picture streams with the type its bytes say; a fake one is refused", () => {
    expect(readChatFile(base, "shot.png")).toMatchObject({ kind: "image", type: "image/png" });
    expect(readChatFile(base, "fake.png")).toBeNull();
  });
  test("outside the folder is refused: dotdot, absolute, symlinked file and symlinked folder", () => {
    expect(readChatFile(base, "../other/secret.ts")).toBeNull();
    expect(readChatFile(base, join(other, "secret.ts"))).toBeNull();
    expect(readChatFile(base, "link.ts")).toBeNull();
    expect(readChatFile(base, "dir/secret.ts")).toBeNull();
  });
  test("secrets, binary, unknown types, missing files and no project are refused", () => {
    expect(readChatFile(base, ".env")).toBeNull();
    expect(readChatFile(base, "notes.pem")).toBeNull();
    expect(readChatFile(base, "app.sqlite")).toBeNull();
    expect(readChatFile(base, "Library/p.json")).toBeNull();
    expect(readChatFile(base, ".claude/s.json")).toBeNull();
    expect(readChatFile(base, "bin.json")).toBeNull();
    expect(readChatFile(base, "src")).toBeNull();
    expect(readChatFile(base, "src/none.ts")).toBeNull();
    expect(readChatFile(base, "a.exe")).toBeNull();
    expect(readChatFile(null, "src/a.ts")).toBeNull();
  });
  test("a big text file is cut at the limit and says so", () => {
    writeFileSync(join(base, "big.log"), ("x".repeat(99) + "\n").repeat(3000));
    const r = readChatFile(base, "big.log");
    expect(r).toMatchObject({ kind: "text", truncated: true });
    if (r?.kind === "text") expect(r.text.length).toBeLessThanOrEqual(TEXT_MAX);
  });
});
