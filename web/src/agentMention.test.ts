import { describe, expect, test } from "bun:test";
import { mdParse } from "./md";
import { mentionAt, mentionStart, setMentionNames } from "./agentMention";

const NAMES = ["root", "designer-macmeng", "builder-2", "builder-agentchip", "verifier-x9"];
const ag = (n: string) => `<span class="cx-agm" data-ag="${n}">${n}</span>`;
const md = (s: string) => mdParse(s, NAMES);
const count = (h: string) => (h.match(/class="cx-agm"/g) ?? []).length;

describe("agent mentions", () => {
  test("a whole known name becomes a placeholder, the rest stays text", () => {
    const h = md("designer-macmeng (Fable) is studying the app; root said go.");
    expect(h).toContain(ag("designer-macmeng") + " (Fable)");
    expect(h).toContain(ag("root") + " said");
    expect(count(h)).toBe(2);
  });
  test("names with dashes and digits match exactly, the longest name wins", () => {
    expect(md("ask builder-2 and verifier-x9")).toContain(ag("builder-2") + " and " + ag("verifier-x9"));
    expect(md("builder-agentchip is here")).toContain(ag("builder-agentchip"));
    expect(count(md("builder-3 and builder-22 and builder"))).toBe(0);
  });
  test("only whole tokens: no match inside words, paths, files, addresses or snake_case", () => {
    for (const s of ["rooted tree", "uproot it", "is_root here", "the root_dir", "see src/root/x.ts", "open root.ts now", "mail root@host.com", "pre-root word", "root-cause", "#root", "x.root"]) expect(count(md(s))).toBe(0);
  });
  test("punctuation after a name and opening punctuation before it", () => {
    const h = md("Ask root. Then (designer-macmeng), \"root\", root's plan, root: yes, root!");
    expect(count(h)).toBe(6);
    expect(h).toContain("(" + ag("designer-macmeng") + "),");
    expect(h).toContain(ag("root") + "&#39;s plan");
  });
  test("case must match: plain English words never turn into chips", () => {
    expect(count(md("Root of the problem and ROOT"))).toBe(0);
  });
  test("code spans and fenced code stay code", () => {
    const h = md("run `root` and `designer-macmeng --x`\n\n```\nroot here\n```");
    expect(count(h)).toBe(0);
    expect(h).toContain("<code>root</code>");
  });
  test("link text and URLs stay as they are", () => {
    const h = md("[root chat](https://example.com/root) and https://example.com/designer-macmeng");
    expect(count(h)).toBe(0);
    expect(h).toContain(">root chat</a>");
  });
  test("mentions inside emphasis, lists, headings and after a bold lead", () => {
    expect(count(md("**root** and *designer-macmeng*"))).toBe(2);
    expect(count(md("- root\n- builder-2 done"))).toBe(2);
    expect(count(md("**Note:** root will go"))).toBe(1);
    expect(count(md("## root"))).toBe(1);
  });
  test("no names given: no mentions (other callers of renderMd)", () => {
    expect(count(mdParse("root said hi"))).toBe(0);
  });
  test("start skips index 0 (unseen left neighbour); the tokenizer takes a lead character", () => {
    setMentionNames(NAMES);
    expect(mentionStart("root x")).toBeUndefined();
    expect(mentionStart("a root")).toBe(2);
    expect(mentionStart("_root and root")).toBe(10);
    expect(mentionAt(" root x")).toEqual({ raw: " root", lead: " ", name: "root" });
    expect(mentionAt("_root")).toBeNull();
    expect(mentionAt("`root`")).toBeNull();
  });
  test("names that are not plain tokens are ignored", () => {
    expect(count(mdParse("a.b x", ["a.b", "<x>", ""]))).toBe(0);
  });
});
