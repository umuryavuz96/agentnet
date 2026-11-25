import { describe, expect, test } from "bun:test";
import { mdParse } from "./md";
import { checkFileChips, codespanKind, hlLine, parseCallout, parseFence } from "./chatMarkers";

describe("chips and coloured text", () => {
  test(":tone[text] becomes a chip, escaped, max 40", () => {
    expect(mdParse(":ok[ui-check 2 pass]")).toContain('<span class="cx-chip cx-ok"><b>ui-check 2 pass</b></span>');
    expect(mdParse(":bad[<i>x</i>]")).toContain("&lt;i&gt;x&lt;/i&gt;");
    const long = ":warn[" + "a".repeat(41) + "]";
    expect(mdParse(long)).not.toContain("cx-chip");
    expect(mdParse(":nope[x]")).not.toContain("cx-chip");
  });
  test("==text== inline is coloured, alone on a line it is the key line", () => {
    expect(mdParse("so ==the rail== here")).toContain('<span class="cx-hl">the rail</span>');
    const k = mdParse("==One thing needs you.==");
    expect(k).toBe('<p class="cx-key">One thing needs you.</p>\n');
    expect(mdParse("a == b and c == d")).not.toContain("cx-hl");
  });
});

describe("reference chips", () => {
  test("message, step, job, PR and sha chips", () => {
    const h = mdParse("answers #8931, closes step 1.2 of job 14 and PR #12 on `839475a`.");
    for (const t of ["#8931", "step 1.2", "job 14", "PR #12", "839475a"]) expect(h).toContain(`<b>${t}</b>`);
    expect(h.match(/cx-ref/g)?.length).toBe(5);
  });
  test("too long or glued ids stay plain", () => {
    const h = mdParse("not #99999999 and abc#12 and https://x.dev/p#12");
    expect(h).not.toContain("cx-ref");
  });
  test("backticks: path stays plain code until the file check, code stays code", () => {
    const h = mdParse("see `web/src/chatBlocks.ts:47`");
    expect(h).toContain('<code class="cx-pq" data-pq="web/src/chatBlocks.ts:47">web/src/chatBlocks.ts:47</code>');
    expect(h).not.toContain("data-path");
    expect(mdParse("a fence that fails `parseBlock()`")).toContain("<code>parseBlock()</code>");
    expect(codespanKind("e.g")).toBeNull();
    expect(codespanKind("deadbeef")).toBeNull();
    expect(codespanKind("README.md")).toBe("file");
  });
});

describe("callouts", () => {
  test("[!OK] makes a card with title and body", () => {
    const h = mdParse("> [!OK] Build passed\n> Typecheck and build are clean.");
    expect(h).toContain('class="cx-callout cx-ok"');
    expect(h).toContain('<b class="cx-ctitle">Build passed</b>');
    expect(h).toContain("Typecheck and build are clean.");
    expect(mdParse("> [!NOTE]\n> t\n> body")).toContain("cx-note");
  });
  test("a plain quote stays a quote", () => { expect(mdParse("> hi")).toContain("<blockquote>"); expect(parseCallout("hi")).toBeNull(); });
});

describe("code block", () => {
  test("title=path:line gives header and numbers; no title gives none", () => {
    expect(parseFence("ts title=web/src/a.ts:30")).toEqual({ lang: "ts", file: "web/src/a.ts", start: 30 });
    const h = mdParse("```ts title=web/src/a.ts:30\nconst a = 1;\nreturn a;\n```");
    expect(h).toContain('data-n="30"');
    expect(h).toContain('data-n="31"');
    expect(h).toContain('data-path="web/src/a.ts"');
    expect(mdParse("```sh\nls\n```")).not.toContain("data-n");
  });
  test("diff lines are washed, code is escaped, tokens coloured", () => {
    const d = mdParse("```diff\n- a\n+ b <i>\n```");
    expect(d).toContain("cx-del");
    expect(d).toContain("cx-add");
    expect(d).toContain("&lt;i&gt;");
    expect(hlLine('const s = "x"; // hi', "ts")).toBe('<span class="cx-k">const</span> s = <span class="cx-s">&quot;x&quot;</span>; <span class="cx-c">// hi</span>');
  });
  test("more than eight lines is cut with a show-all button", () => {
    const h = mdParse("```ts\n" + Array.from({ length: 11 }, (_, i) => "a" + i).join("\n") + "\n```");
    expect(h).toContain("md-code cut");
    expect(h).toContain("Show all 11 lines");
    expect(mdParse("```ts\na\n```")).not.toContain("md-more");
  });
});

describe("plain text is unchanged", () => {
  test("no markers, same output as before", () => {
    expect(mdParse("Hello **world**, a [link](https://example.com).\n\n- a\n- b")).toBe(
      '<p>Hello <strong>world</strong>, a <a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>.</p>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n');
  });
});

describe("file check, Jira keys, picture paths", () => {
  // A tiny stand-in for the two DOM calls checkFileChips makes.
  const fakeRoot = (paths: string[]) => {
    const els = paths.map((p) => ({ dataset: { pq: p } as Record<string, string>, isConnected: true, outerHTML: `<code>${p}</code>` }));
    return { els, root: { querySelectorAll: () => els.filter((e) => !("pc" in e.dataset)) } as unknown as ParentNode };
  };
  test("only a path the service has becomes a chip; one probe per agent and path", async () => {
    const asked: string[] = [];
    const exists = async (p: string) => { asked.push(p); return p === "web/src/md.ts"; };
    const a = fakeRoot(["web/src/md.ts", "web/src/nope.ts"]);
    checkFileChips(a.root, "t1", exists);
    await new Promise((r) => setTimeout(r, 0));
    expect(a.els[0]!.outerHTML).toContain('data-path="web/src/md.ts"');
    expect(a.els[1]!.outerHTML).toBe("<code>web/src/nope.ts</code>");
    const b = fakeRoot(["web/src/md.ts:12-20"]);
    checkFileChips(b.root, "t1", exists);
    expect(b.els[0]!.outerHTML).toContain('data-path="web/src/md.ts:12-20"'); // line range kept on the chip; file known: swapped at once, no second request
    expect(asked).toEqual(["web/src/md.ts", "web/src/nope.ts"]);
  });
  test("a failed probe leaves the code", async () => {
    const a = fakeRoot(["x/y.ts"]);
    checkFileChips(a.root, "t2", () => Promise.reject(new Error("down")));
    await new Promise((r) => setTimeout(r, 0));
    expect(a.els[0]!.outerHTML).toBe("<code>x/y.ts</code>");
  });
  test("Jira key in prose is a jira chip; look-alikes stay text", () => {
    expect(mdParse("Filed AGN-388 for the rail.")).toContain('<span class="cx-chip cx-jira">');
    expect(mdParse("Filed AGN-388 for the rail.")).toContain("<b>AGN-388</b>");
    expect(mdParse("see (AGN-412) and AGN-9")).toMatch(/\(<span class="cx-chip cx-jira">.*AGN-412.*\).*AGN-9/);
    for (const t of ["UTF-8 text", "a UTF-8 text", "uses SHA-256", "see CVE-2024-1234", "xAGN-12", "A-1", "ABCDEFGHIJK-1", "file BRIEF-2026-11-23.md"]) expect(mdParse(t)).not.toContain("cx-jira");
  });
  test("a local picture in a sentence is a checked path; a web picture stays a link", () => {
    expect(mdParse("see ![The chat](docs/shot.png) here")).toContain('data-pq="docs/shot.png"');
    expect(mdParse("see ![x](https://e.com/a.png)")).toContain('<a href="https://e.com/a.png"');
  });
  test("bold words opening a paragraph are marked as the lead; bold later is plain", () => {
    expect(mdParse("**Build passed** Typecheck is clean.")).toBe('<p><strong class="cx-lead">Build passed</strong> Typecheck is clean.</p>\n');
    expect(mdParse("The **build** passed")).toBe("<p>The <strong>build</strong> passed</p>\n");
  });
});
