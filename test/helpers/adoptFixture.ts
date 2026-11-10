// Builds the invented "harbor" workspace used by the adopt tests. Names are made up on purpose: no real tool names.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_ENV_BODY = "TOKEN=abc123\n";

export function makeWorkspace(tmp: string): { ws: string; home: string } {
  const home = join(tmp, "home"), ws = join(tmp, "work", "harbor");
  const w = (base: string, rel: string, body: string) => { const p = join(base, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); };
  mkdirSync(home, { recursive: true });
  const claudeMd = [
    "# Harbor workspace", "", "You are main, coordinator of the harbor team.", "", "## Build", "Run `make test` before you push.", "", "## Style", "Use tabs.", "", "## Coordination", "", "",
    "Report to the team with the pigeon tool; check your inbox each turn.",
    "When a repo agent finishes, send a message to the coordinator.", "", "", "",
    "Poll the inbox at ~/.bus/inbox every turn.", "Never ping an agent twice.", "",
  ];
  w(ws, "CLAUDE.md", claudeMd.join("\n"));
  w(ws, ".mcp.json", JSON.stringify({ mcpServers: { pigeon: { command: "pigeon-mcp", args: [], env: { PIGEON_KEY: "sk-live-1234567890" } }, lint: { command: "lint-mcp" } } }, null, 2) + "\n"); // gitleaks:allow (fake key: redaction fixture)
  w(ws, ".claude/settings.json", JSON.stringify({
    permissions: { allow: ["mcp__pigeon__send_message", "mcp__lint__run"] },
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/bin/pull-msgs.sh" }] }],
      Stop: [{ hooks: [{ type: "command", command: "prettier --check ." }] }],
    },
  }, null, 2) + "\n");
  w(ws, "bin/pull-msgs.sh", "#!/bin/sh\ncat ~/.bus/inbox/$AGENT\n");
  w(home, ".bus/inbox/main.txt", "hello\n");
  w(ws, "ios/.claude/agents/ios.md", "---\nname: ios\ndescription: Builds the iOS app\ntools: Read, Edit, Bash\nmodel: sonnet\n---\nYou are the iOS engineer. Follow the repo rules.\n");
  w(ws, "ios/CLAUDE.md", "# ios\nUse xcodebuild.\n");
  for (const r of ["ios", "kmp", "bff", "e2e", "chameleon"]) { w(ws, `${r}/.git/HEAD`, "ref: refs/heads/main\n"); if (r !== "ios") w(ws, `${r}/CLAUDE.md`, `# ${r}\nRepo rules.\n`); }
  w(ws, ".env", FIXTURE_ENV_BODY);
  return { ws, home };
}
