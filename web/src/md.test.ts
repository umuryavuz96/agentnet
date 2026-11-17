import { describe, expect, test } from "bun:test";
import { mdParse, renderMd } from "./md";

describe("mdParse", () => {
  test("renders the elements agents write", () => {
    const h = mdParse("# Title\n\n**bold** and *italic* and `code`\n\n- one\n- two\n\n1. first\n\n> quote\n\n---");
    for (const tag of ["<h1>", "<strong>bold</strong>", "<em>italic</em>", "<code>code</code>", "<ul>", "<ol>", "<blockquote>", "<hr>"]) expect(h).toContain(tag);
  });
  test("a single newline is a line break", () => { expect(mdParse("a\nb")).toContain("<br>"); });
  test("raw HTML from an agent is escaped, block and inline", () => {
    const h = mdParse('<script>alert(1)</script>\n\ntext <img src=x onerror="alert(1)"> <b>x</b>');
    expect(h).not.toContain("<script");
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<b>");
    expect(h).toContain("&lt;script&gt;");
  });
  test("links open in a new tab with noopener; unsafe schemes lose the link", () => {
    expect(mdParse("[a](https://example.com)")).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">a</a>');
    const bad = mdParse("[x](javascript:alert(1)) [y](data:text/html,hi) [z](/local)");
    expect(bad).not.toContain("<a ");
    expect(bad).not.toContain("javascript:");
  });
  test("an image becomes a link, never a request", () => {
    const h = mdParse("![shot](https://example.com/a.png)");
    expect(h).not.toContain("<img");
    expect(h).toContain('href="https://example.com/a.png"');
  });
  test("fenced code is escaped and gets a copy button", () => {
    const h = mdParse("```ts\nconst a = '<b>';\n```");
    expect(h).toContain('<div class="md-code">');
    expect(h).toContain('<button type="button" class="md-copy">Copy</button>');
    expect(h).toContain("&lt;b&gt;");
    expect(h).toContain("<span>ts</span>");
  });
  test("a code language cannot carry markup", () => { expect(mdParse('```"><i>\nx\n```')).not.toContain("<i>"); });
  test("a table sits in its own scroll box", () => {
    const h = mdParse("| a | b |\n|---|:-:|\n| 1 | 2 |");
    expect(h).toContain('<div class="md-table"><table>');
    expect(h).toContain("</table>\n</div>");
  });
  test("checklists draw our own tick, no native input", () => {
    const h = mdParse("- [x] done\n- [ ] open");
    expect(h).not.toContain("<input");
    expect(h).toContain('class="md-cb on"');
    expect(h).toContain('aria-label="not done"');
  });
});

test("renderMd fails closed to escaped text without a DOM", () => {
  expect(renderMd("**b** <i>x</i>")).toBe("<p>**b** &lt;i&gt;x&lt;/i&gt;</p>");
});
