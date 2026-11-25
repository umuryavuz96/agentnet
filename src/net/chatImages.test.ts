import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_MAX, agentRead, readableImage, sniff, storeDir, storeImage } from "./chatImages";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const tmp = () => mkdtempSync(join(tmpdir(), "chat-img-"));

describe("what counts as a picture", () => {
  test("the first bytes decide, not the name", () => {
    expect(sniff(PNG)).toBe("png");
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(sniff(new TextEncoder().encode("GIF89a...."))).toBe("gif");
    expect(sniff(new TextEncoder().encode("RIFF....WEBPVP8 "))).toBe("webp");
    expect(sniff(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'>"))).toBeNull();
    expect(sniff(new TextEncoder().encode("<!doctype html>"))).toBeNull();
  });
});

describe("keeping a pasted picture", () => {
  test("it lands under the agent's folder with the type the bytes say", () => {
    const root = tmp(), r = storeImage("builder-1", PNG, root);
    if ("error" in r) throw new Error(r.error);
    expect(r.path.startsWith(storeDir("builder-1", root) + "/")).toBe(true);
    expect(r.path.endsWith(".png")).toBe(true);
    expect(readableImage("builder-1", r.path, null, root)?.[1]).toBe("image/png");
  });
  test("empty, too large and not-a-picture are refused", () => {
    const root = tmp();
    expect(storeImage("a", new Uint8Array(0), root)).toEqual({ error: "the picture is empty" });
    expect(storeImage("a", new Uint8Array(IMAGE_MAX + 1), root)).toEqual({ error: "picture over 10 MB" });
    expect(storeImage("a", new TextEncoder().encode("<script>alert(1)</script>"), root)).toEqual({ error: "not a PNG, JPEG, GIF or WebP picture" });
  });
});

describe("which files the page may see", () => {
  test("another agent's picture, a path with .., a relative path and a non-image name are refused", () => {
    const root = tmp(), r = storeImage("a", PNG, root) as { path: string };
    expect(readableImage("b", r.path, null, root)).toBeNull();
    expect(readableImage("a", storeDir("a", root) + "/../a/" + r.path.split("/").pop(), null, root)).toBeNull();
    expect(readableImage("a", "x.png", null, root)).toBeNull();
    const secret = join(root, "secret.txt"); writeFileSync(secret, "token");
    expect(readableImage("a", secret, null, root)).toBeNull();
  });
  test("a file named .png that is not a picture never comes out, even when the agent read it", () => {
    const root = tmp(), fake = join(root, "notes.png"), log = join(root, "t.jsonl");
    writeFileSync(fake, "secret text");
    writeFileSync(log, `{"message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":${JSON.stringify(fake)}}}]}}\n`);
    expect(agentRead(log, fake)).toBe(true);
    expect(readableImage("a", fake, log, root)).toBeNull();
  });
  test("a picture the agent read is served; one it only heard about is not", () => {
    const root = tmp(), shot = join(root, "shot.png"), other = join(root, "other.png"), log = join(root, "t.jsonl");
    writeFileSync(shot, PNG); writeFileSync(other, PNG);
    // `other` appears only inside a prompt's text, where its quotes are escaped
    writeFileSync(log, `{"message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":${JSON.stringify(shot)}}}]}}\n` + JSON.stringify({ message: { content: `"name":"Read","input":{"file_path":${JSON.stringify(other)}}` } }) + "\n");
    expect(readableImage("a", shot, log, root)?.[1]).toBe("image/png");
    expect(readableImage("a", other, log, root)).toBeNull();
    expect(readableImage("a", shot, null, root)).toBeNull();
  });
  test("a picture the agent names as the src of an image block is served", () => {
    const root = tmp(), shot = join(root, "after.png"), log = join(root, "t.jsonl"); writeFileSync(shot, PNG);
    const reply = "```ui\n" + JSON.stringify({ type: "image", src: shot }, null, 1) + "\n```";
    writeFileSync(log, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: reply }] } }) + "\n");
    expect(readableImage("a", shot, log, root)?.[1]).toBe("image/png");
    const tight = join(root, "t2.jsonl");
    writeFileSync(tight, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "```ui\n" + JSON.stringify({ type: "image", src: shot }) + "\n```" }] } }) + "\n");
    expect(readableImage("a", shot, tight, root)?.[1]).toBe("image/png");
  });
  test("a link out of the agent's folder is not one of its pictures", () => {
    const root = tmp(), outside = join(root, "outside.png"); writeFileSync(outside, PNG);
    storeImage("a", PNG, root);
    const link = join(storeDir("a", root), "link.png"); symlinkSync(outside, link);
    expect(readableImage("a", link, null, root)).toBeNull();
  });
});
