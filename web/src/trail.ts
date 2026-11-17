// Words for a tool call (board page 03 R.phrase): never the raw command or path.
const VERB: Record<string, string> = { Read: "Reading", Edit: "Editing", Write: "Writing", Grep: "Searching", Glob: "Searching", Bash: "Running a command", ToolSearch: "Loading tools", Agent: "Running a subagent", WebSearch: "Searching the web", WebFetch: "Reading a web page" };
export const phrase = (t: { tool: string; target?: string | null } | null | undefined): string => {
  if (!t) return "";
  const v = VERB[t.tool] ?? (t.tool.startsWith("mcp__") ? (/playwright|chrome|browser/i.test(t.tool) ? "Using a browser" : "Using " + (t.tool.split("__")[1] ?? "a tool").replace(/^claude[-_]ai[-_]/i, "").replace(/[-_]/g, " ")) : "Using " + t.tool);
  return v + (/^(Read|Edit|Write)$/.test(t.tool) && t.target ? " " + t.target.split("/").pop()!.slice(0, 24) : "");
};
export const agoShort = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + "s"; const m = Math.floor(s / 60); if (m < 60) return m + "m"; const h = Math.floor(m / 60); return h < 48 ? h + "h" : Math.floor(h / 24) + "d"; };
// Board R.ago: "now" under 90 s, then minutes, hours, days in words.
export const agoWords = (ms: number) => { const s = Math.max(0, ms / 1000); return s < 90 ? "now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago"; };
