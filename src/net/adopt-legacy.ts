// Leftovers of agentnet's own predecessor (agmsg): its MCP server, hooks and CLAUDE.md lines. The scan stays product-agnostic
// (test: no product names in adopt source); this is the one file that names the predecessor, because cleaning it up is on by default.
export const LEGACY_RE = /agmsg/i;
export const isLegacy = (text: string): boolean => LEGACY_RE.test(text);
