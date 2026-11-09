import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _reset, askClaude, redact, setAsk, summarize, tidy } from "./bgsum";

afterEach(() => { setAsk(null); _reset(); });

describe("redact", () => {
  test("secrets never survive", () => {
    const secrets = ["sk-ant-api03-abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "hunter2hunter2", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123", "AbCdEf0123456789AbCdEf0123456789AbCd", "0123456789abcdef0123456789abcdef", "s3cr3t-pw", "xoxb-1234567890-abcdef"];
    const cmd = `API_KEY=${secrets[0]} GITHUB_TOKEN="${secrets[1]}" curl -H "Authorization: Bearer ${secrets[3]}" https://u:${secrets[2]}@host/x --password ${secrets[6]} --token ${secrets[7]} && echo ${secrets[4]} ${secrets[5]}`;
    const out = redact(cmd);
    for (const s of secrets) expect(out).not.toContain(s);
    expect(out).toContain("curl");
    expect(out).toContain("API_KEY=•••");
  });
  test("plain commands pass through, whitespace collapsed, capped at 400", () => {
    expect(redact("until  grep -q F6GRID_DONE ~/projects/x/log.txt; do sleep 30; done")).toBe("until grep -q F6GRID_DONE ~/projects/x/log.txt; do sleep 30; done");
    expect(redact("x".repeat(1000)).length).toBeLessThanOrEqual(400);
  });
  test("private key blocks are cut", () => { expect(redact("echo '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'")).not.toContain("MIIabc"); });
});

describe("tidy", () => {
  test("one clean line, no quotes or final period", () => {
    expect(tidy('"Waits for the flat-6 render batch to finish."\n')).toBe("Waits for the flat-6 render batch to finish");
    expect(tidy("Summary: Runs the tests\nextra line")).toBe("Runs the tests");
  });
  test("refusals and empty output are rejected; a long answer is cut to 12 words", () => {
    expect(tidy("")).toBeNull(); expect(tidy("I cannot help with that")).toBeNull();
    expect(tidy("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen")!.split(" ").length).toBe(12);
  });
});

describe("summarize", () => {
  test("cached per command, in-flight calls shared, at most two at once, failures not cached", async () => {
    let calls = 0, live = 0, peak = 0;
    setAsk(async (c) => { calls++; live++; peak = Math.max(peak, live); await Bun.sleep(20); live--; return c.includes("fail") ? null : `Does ${c.length}`; });
    const [a, b] = await Promise.all([summarize("sleep 5"), summarize("sleep 5")]);
    expect(a).toBe(b); expect(calls).toBe(1);
    expect(await summarize("sleep 5")).toBe(a); expect(calls).toBe(1);
    await Promise.all(["a1", "a2", "a3", "a4", "a5"].map((c) => summarize("echo " + c)));
    expect(peak).toBeLessThanOrEqual(2);
    expect(await summarize("fail 1")).toBeNull(); expect(await summarize("fail 1")).toBeNull(); // asked again
    expect(calls).toBe(1 + 5 + 2);
  });
  test("the model only ever sees the redacted command", async () => {
    let seen = "";
    setAsk(async (c) => { seen = c; return "Calls a service"; });
    await summarize("curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://x.test");
    expect(seen).not.toContain("abcdefghijklmnop1234");
  });
});

describe("askClaude (claude stubbed on PATH)", () => {
  test("runs the documented flags, feeds the prompt on stdin, returns the tidy sentence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bgsum-"));
    writeFileSync(join(dir, "claude"), `#!/bin/sh\necho "$@" > "${dir}/args"\ncat > "${dir}/stdin"\necho '"Waits for the render batch to finish."'\n`);
    chmodSync(join(dir, "claude"), 0o755);
    const old = process.env.PATH; process.env.PATH = `${dir}:${old}`;
    try { expect(await askClaude("until grep -q DONE log; do sleep 1; done")).toBe("Waits for the render batch to finish"); } finally { process.env.PATH = old; }
    expect(readFileSync(join(dir, "args"), "utf8").trim()).toBe("-p --model haiku --strict-mcp-config --setting-sources  --disable-slash-commands"); // the empty value after --setting-sources is an empty argument
    expect(readFileSync(join(dir, "stdin"), "utf8")).toContain("until grep -q DONE log");
  });
  test("a failing or missing claude gives null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bgsum-"));
    writeFileSync(join(dir, "claude"), "#!/bin/sh\nexit 3\n"); chmodSync(join(dir, "claude"), 0o755);
    expect(await askClaude("x", join(dir, "claude"))).toBeNull();
    expect(await askClaude("x", join(dir, "nope"))).toBeNull();
  });
});

describe("bgsum subscription only", () => {
  test("source has no API key or API endpoint path", () => {
    const src = readFileSync(join(import.meta.dir, "bgsum.ts"), "utf8");
    expect(src).not.toMatch(new RegExp(["ANTHROPIC_API" + "_KEY", "x-api-key", "api\\.anthropic" + "\\.com", "@anthropic-ai/sdk"].join("|"), "i"));
  });
});
