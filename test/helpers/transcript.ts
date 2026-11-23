// Fixture transcripts for the proof tests (step 8 proof fix). They live in a scratch Claude home (AGENTNET_CLAUDE_HOME):
// a test never reads a real transcript. Rows have the shape Claude Code writes: a tool_use in an assistant message, its
// tool_result in the next user message, each row with an ISO timestamp.
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Point AGENTNET_CLAUDE_HOME at a fresh scratch dir. Returns the dir and a function that puts the old value back. */
export function scratchClaudeHome(): { home: string; restore: () => void } {
  const old = process.env.AGENTNET_CLAUDE_HOME, home = mkdtempSync(join(tmpdir(), "an-claude-home-"));
  process.env.AGENTNET_CLAUDE_HOME = home;
  return { home, restore: () => { if (old === undefined) delete process.env.AGENTNET_CLAUDE_HOME; else process.env.AGENTNET_CLAUDE_HOME = old; } };
}
/** Where the feed looks for a session's transcript of a working dir (feed.ts projectDir, on the default config dir). */
export const transcriptPath = (home: string, cwd: string, session: string) => join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`);

export interface FixtureCall { id: string; tool: string; input: Record<string, unknown>; output?: string; isError?: boolean; at?: number; result?: boolean }
/** Append one tool call (and, unless result is false, its result) to a transcript file. */
export function writeCall(file: string, c: FixtureCall) {
  mkdirSync(dirname(file), { recursive: true });
  const ts = new Date(c.at ?? Date.now()).toISOString();
  const rows: unknown[] = [{ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id: c.id, name: c.tool, input: c.input }] } }];
  if (c.result !== false) rows.push({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: c.id, content: c.output ?? "", is_error: c.isError === true }] } });
  appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
/** Append only the result of a call written earlier with result: false. */
export function writeResult(file: string, id: string, output: string, isError = false, at = Date.now()) {
  appendFileSync(file, JSON.stringify({ type: "user", timestamp: new Date(at).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: isError }] } }) + "\n");
}
