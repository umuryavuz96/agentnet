// DEV ONLY (never imported by the shipped app): a tiny server for the adopt onboarding UI until the real section-11 API runs.
// Serves web/dist plus canned /v1/panel routes. Run: bun web/dev/adopt-stub.ts [port]   (default 5197; scratch only, no files written)
// Names in the canned data are invented (pigeon, harbor); no real tool is named.
import { join, normalize } from "node:path";

const port = Number(process.argv[2] ?? 5197);
const DIST = join(import.meta.dir, "..", "dist");
const WS = "/Users/you/work/harbor";

const report = {
  version: 1, scanId: "scan-a1b2c3d4", workspace: WS, scanner: "director",
  summary: "Found 1 second message system, a main-agent claim and 5 repo agents.",
  findings: [
    { id: "f1", kind: "coordination-system", title: "Looks like a second coordination system", confidence: "high", risk: "medium", agents: ["ios", "kmp", "bff", "chameleon", "e2e"], suggestion: "switch-off",
      about: "A hook feeds messages into every prompt, a tool named \"pigeon\" sends them, and CLAUDE.md tells agents to report through it. Two systems on the same agents will clash.",
      evidence: [
        { signal: "g1", path: `${WS}/.claude/settings.json`, quote: "UserPromptSubmit -> ~/bin/pull-msgs.sh" },
        { signal: "g2", path: `${WS}/.mcp.json`, quote: "server pigeon (command pigeon-mcp)" },
        { signal: "g3", path: `${WS}/CLAUDE.md`, line: 14, quote: "Report to the team with the pigeon tool; check your inbox each turn." },
        { signal: "g4", path: `${WS}/bin/pull-msgs.sh`, line: 12, quote: "cat ~/.bus/inbox/$AGENT" }],
      actions: [
        { id: "a1", op: "park-hook", file: `${WS}/.claude/settings.json`, event: "UserPromptSubmit", commandIncludes: "pull-msgs.sh" },
        { id: "a2", op: "park-mcp", file: `${WS}/.mcp.json`, server: "pigeon" }] },
    { id: "f2", kind: "identity-claim", title: "Your CLAUDE.md says who the main agent is", confidence: "medium", risk: "low", agents: [], suggestion: "neutralise-lines",
      about: "Line 3: \"You are main, coordinator of the harbor team.\" The director would take that name. agentnet already names it.",
      evidence: [{ signal: "g5", path: `${WS}/CLAUDE.md`, line: 3, quote: "You are main, coordinator of the harbor team." }],
      actions: [{ id: "a3", op: "disable-lines", file: `${WS}/CLAUDE.md`, fromLine: 3, toLine: 5, why: "identity and reporting lines" }] },
    { id: "f3", kind: "agent-definitions", title: "5 repos have their own agent", confidence: "high", risk: "low", agents: ["ios", "kmp", "bff", "chameleon", "e2e"], suggestion: "adopt-as-souls",
      about: "Add them as workspace souls so spawning ios-1 starts in that repo with its own definition.",
      evidence: [{ signal: "g6", path: `${WS}/ios/.claude/agents/ios.md` }],
      actions: ["ios", "kmp", "bff", "chameleon", "e2e"].map((n, i) => ({ id: `a${4 + i}`, op: "register-souls", repo: `${WS}/${n}`, name: n, source: n === "ios" ? "agent-def" : "claude-md", ...(n === "ios" ? { defFile: `${WS}/ios/.claude/agents/ios.md` } : {}) })) },
    { id: "f4", kind: "scheduled-runner", title: "2 tmux sessions still run the old agents", confidence: "high", risk: "medium", agents: ["ios", "kmp"], suggestion: "manual",
      about: "agentnet will not stop them. Copy, run, then Scan again.", evidence: [{ signal: "g7", path: `${WS}`, quote: "tmux session ios, kmp" }],
      actions: [{ id: "a9", op: "manual", title: "Stop the ios session", command: "tmux kill-session -t ios", why: "it still runs the old agent loop" }, { id: "a10", op: "manual", title: "Stop the kmp session", command: "tmux kill-session -t kmp", why: "same" }] },
    { id: "f5", kind: "hook", title: "A formatter hook on Stop", confidence: "high", risk: "low", agents: [], suggestion: "keep-as-is", about: "Runs prettier. Not coordination.", evidence: [{ signal: "g8", path: `${WS}/.claude/settings.json` }], actions: [] },
    { id: "f6", kind: "mcp-server", title: "A lint server", confidence: "high", risk: "low", agents: [], suggestion: "keep-as-is", about: "Checks code style. Not coordination.", evidence: [{ signal: "g9", path: `${WS}/.mcp.json` }], actions: [] },
  ],
};
const plan = (global: boolean) => ({
  planId: "plan-9f3a1c27b0de4a55", workspace: WS,
  ops: [
    { id: "o1", op: "park-hook", file: `${WS}/.claude/settings.json`, global: false, beforeSha: "a", afterSha: "b", fromActions: ["a1"], findingId: "f1",
      diff: "--- a/.claude/settings.json\n+++ b/.claude/settings.json\n@@ -3,12 +3,4 @@\n   \"hooks\": {\n-    \"UserPromptSubmit\": [\n-      { \"hooks\": [{ \"type\": \"command\", \"command\": \"~/bin/pull-msgs.sh\" }] }\n-    ],\n     \"Stop\": [\n       { \"hooks\": [{ \"type\": \"command\", \"command\": \"prettier --check .\" }] }\n     ]\n" },
    { id: "o2", op: "park-mcp", file: `${WS}/.mcp.json`, global: false, beforeSha: "c", afterSha: "d", fromActions: ["a2"], findingId: "f1",
      diff: "--- a/.mcp.json\n+++ b/.mcp.json\n@@ -1,8 +1,4 @@\n {\n   \"mcpServers\": {\n-    \"pigeon\": { \"command\": \"pigeon-mcp\" },\n     \"lint\": { \"command\": \"lint-mcp\" }\n   }\n }\n" },
    { id: "o3", op: "disable-lines", file: `${WS}/CLAUDE.md`, global: false, beforeSha: "e", afterSha: "f", fromActions: ["a3"], findingId: "f2",
      diff: "--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,6 +1,4 @@\n # Harbor workspace\n \n-You are main, coordinator of the harbor team.\n-Report to the team through the tool \"pigeon\".\n+<!-- agentnet: lines 3-5 switched off by run run-20261110-101500; original in backup -->\n \n Build with make.\n" },
    ...(global ? [{ id: "o4", op: "park-hook", file: "/Users/you/.claude/settings.json", global: true, beforeSha: "g", afterSha: "h", fromActions: [], diff: "--- a/settings.json\n+++ b/settings.json\n@@ -1,5 +1,2 @@\n-  \"hooks\": { \"SessionStart\": [] }\n" }] : []),
    { op: "register-souls", create: ["ios", "kmp", "bff", "chameleon", "e2e"].map((n) => `~/.local/share/agentnet/workspace/souls/${n}.md`), preview: "You are the ios agent for the repository at /Users/you/work/harbor/ios.\nRead and follow its CLAUDE.md for every rule about this repo.\nCoordination goes through agentnet only." },
    { op: "write-director-prompt", create: ["~/.local/share/agentnet/run/souls/agentnet-director.md"], preview: "# Workspace precedence (agentnet adopted this workspace)\nYou are the agentnet Director (agent name: root)." },
  ],
  willBackup: [`${WS}/.claude/settings.json`, `${WS}/.mcp.json`, `${WS}/CLAUDE.md`],
  backupDir: "~/.local/share/agentnet/adopt/run-20261110-101500/", rollbackCommand: "agentnet adopt rollback run-20261110-101500",
  warnings: global ? ["Global file included: ~/.claude/settings.json"] : [],
});

let st: Record<string, unknown> = fresh();
function fresh() { return { phase: "idle", mode: null, workspace: null, scanId: null, planId: null, runId: null, scanner: null, facts: null, failed: null, report: null, plan: null, runs: [] as unknown[] }; }
let live = false;
const clients = new Set<ReadableStreamDefaultController>();
const enc = new TextEncoder();
const hello = () => `event: hello\ndata: ${JSON.stringify({ seq: 1, agents: live ? { "root#1": { id: "root#1", name: "root", life: "live", state: "idle", tasks: [], job: null, boss: null } } : {}, messages: [], checks: [] })}\n\n`;
const push = () => { for (const c of clients) try { c.enqueue(enc.encode(hello())); } catch { clients.delete(c); } };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const timers: ReturnType<typeof setTimeout>[] = [];
const sleepSet = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

Bun.serve({
  port, idleTimeout: 0,
  async fetch(req) {
    const u = new URL(req.url), p = u.pathname;
    if (p === "/v1/panel/snapshot") return json({});
    if (p === "/v1/panel/stream") {
      return new Response(new ReadableStream({ start(c) { clients.add(c); c.enqueue(enc.encode(hello())); }, cancel() { /* controller dropped on next push */ } }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    if (p === "/v1/panel/director" && req.method === "GET") {
      const dir = u.searchParams.get("dir") || WS;
      const empty = u.searchParams.get("dir")?.includes("empty");
      return json({ home: WS, dir, dirError: null, tools: { bun: true, claude: true, tmux: true, python3: true }, root: live, session: false, sessionName: "agentnet-root",
        command: `cd ${dir} && eval "$(agentnet-join.sh root Director ${dir})" && claude --plugin-dir "$AGENTNET_MOD" --append-system-prompt-file ~/.local/share/agentnet/run/souls/agentnet-director.md`,
        precheck: empty ? { instructions: false, claudeDir: false, repos: 0, agentDefs: 0, tmuxAgents: 0 } : { instructions: true, claudeDir: true, repos: 5, agentDefs: 5, tmuxAgents: 2 } });
    }
    if (p === "/v1/panel/director/start") { live = true; push(); return json({}); }
    if (p === "/v1/panel/director/pick-folder") return json({ dir: WS });
    if (p === "/v1/panel/adopt" && req.method === "GET") return json(st);
    if (p === "/v1/panel/adopt/scan") {
      const b = await req.json() as { dir: string; mode: string };
      const fail = b.dir.includes("fail");
      st = { ...fresh(), phase: "scanning", mode: "adopt", workspace: b.dir, scanId: report.scanId, scanner: b.mode };
      sleepSet(500, () => { st.facts = { signals: 12 }; });
      sleepSet(fail ? 2500 : 4500, () => { if (st.phase !== "scanning") return; if (fail) st.failed = "The director did not report within 180 s."; else { st.phase = "reported"; st.report = { ...report, scanner: b.mode }; } });
      return json({ scanId: report.scanId });
    }
    if (p === "/v1/panel/adopt/cancel") { timers.forEach(clearTimeout); st = fresh(); return json({}); }
    if (p === "/v1/panel/adopt/plan") {
      const b = await req.json() as { picks: { findings: Record<string, string> } };
      const global = String(st.workspace).includes("global");
      st.phase = "planned"; st.plan = plan(global); st.planId = (st.plan as { planId: string }).planId;
      return json(st.plan);
    }
    if (p === "/v1/panel/adopt/apply") {
      const b = await req.json() as { planId: string };
      if (b.planId !== st.planId) return json({ title: "Conflict", detail: "A file changed since the preview. Preview again." }, 409);
      st.phase = "applied"; st.runId = "run-20261110-101500"; st.runs = [{ runId: "run-20261110-101500", at: Date.now(), workspace: WS, files: 3, state: "applied" }];
      sleepSet(1500, () => { live = true; push(); });
      return json({ runId: st.runId });
    }
    if (p === "/v1/panel/adopt/clean") { live = false; st.phase = "applied"; st.mode = "clean"; return json({}); }
    if (p === "/v1/panel/adopt/rollback") { st.phase = "rolledback"; return json({}); }
    if (p === "/__reset") { timers.forEach(clearTimeout); st = fresh(); live = false; push(); return json({}); }
    if (p === "/v1/panel/bgjobs") return json([]);
    if (p === "/v1/panel/hooks/stream") return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(": ok\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
    if (p.startsWith("/v1/")) { console.log("stub: unhandled", req.method, p); return json({ teams: [], nodes: [], agents: [], checks: [], tasks: [], jobs: [], list: [] }); }
    // static
    const file = normalize(join(DIST, p === "/" ? "index.html" : p));
    if (file.startsWith(DIST) && (await Bun.file(file).exists())) return new Response(Bun.file(file));
    return new Response(Bun.file(join(DIST, "index.html")));
  },
});
console.log(`adopt stub on http://127.0.0.1:${port} (dev only)`);
