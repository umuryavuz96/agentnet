# Changelog

## 0.5.2

When the director cannot start, the setup window now shows why. Reset director now really starts you over.

**Director start failures**

- If Claude Code exits right after it starts (an old version, not signed in), the Director ready step shows what it printed, its exit code and a hint: update Claude Code, or run `claude` once and sign in. The tmux session step stays green and "Claude Code is starting" shows the failure.
- A director whose process has exited is no longer counted as running. Retry and Reset work on it as on a missing one.

**Reset director**

- Fixed: after Reset director, opening setup jumped to "Director ready" with nothing started and reported "The tmux session ended before the director connected".
- Reset now returns to a first-run state. It undoes an applied adopt run (files you changed since are kept), clears the adopt state, the start record and the director's prompt files, and removes the director home note if you did not edit it. Your projects, backups, Claude transcripts and Claude login are never touched.

## 0.5.1

Adopt setup is one guided flow, explains what it changes, and no longer hangs on "waiting for director".

**Guided setup**

- The first-run window walks you through the steps in order: folder, setup type, scan, review, preview, apply, director ready. Only the next step is active, and a step turns green only when it is really done. A director that was already running no longer turns steps green early.
- Each finding says what it changes, as **Now** and **After** in plain words.
- An **After adopt** panel in review and preview shows your team (director, workspace souls and roles), what keeps running, what gets switched off (backed up) and how messages flow.

**Director start after Apply**

- Fixed: after Apply the page could wait forever. The director starts in a hidden tmux window, and Claude Code was waiting there at its folder-trust or MCP-approval question.
- The Director ready step now shows the real stages (tmux session, Claude Code starting, questions answered, director said hello) with a 5-minute limit, then the reason, the last terminal lines and **Retry**.
- When Claude Code asks to trust the folder or approve MCP servers, the step shows the question with one button. agentnet sends the keys only when the terminal shows exactly that question. MCP servers that adopt switched off stay unchecked.
- Rollback also undoes the `.claude/settings.local.json` that Claude Code writes when the MCP question is answered.

**Agents**

- An agent whose tmux session ended is shown as lost instead of idle. Messages sent to it are refused with state `lost` (HTTP 409), so callers can fall back, and its unread messages are delivered when it is spawned again.

## 0.5.0

Adopt an existing Claude Code workspace: agentnet scans what you already have, shows every change as a diff, backs up what it touches and can undo it.

**Adopt my workspace**

- The first-run window has a new choice in step 2: **Adopt my workspace** next to **Clean**. Use it when your project already has its own `CLAUDE.md` rules, hooks, MCP servers or per-repo agents.
- **Scan.** A collector gathers signals (hooks, MCP servers, instruction lines, running agent panes, repo agent definitions). It never reads `.env`, keys or tokens. The director reads the evidence in a read-only session that starts by itself, with project hooks and project MCP servers off, and never writes into the workspace. **Basic scan** makes no model call.
- **Review.** Findings show as cards. Per card you choose: switch off a second message system, add repo agents as workspace souls, replace identity lines, or keep as is. Things only you can do (stop a tmux session, unload a launchd job) show as commands to copy; agentnet never runs them. Changes to global files sit behind their own checkbox. Neutralising instruction lines is off by default and opt-in per line.
- **Preview.** Every file with a real diff and every file it creates. Apply refuses (409) when a file changed since the preview.
- **Apply.** Everything touched is backed up first under `$AGENTNET_HOME/adopt/<runId>/`. A failed step rolls the run back by itself.
- **Undo.** One-call rollback. A file you edited after Apply is kept and reported unless you force it.
- The director then starts in your workspace in adopt mode. Your `CLAUDE.md` and rules still load; a precedence block makes agentnet the only coordination layer while repo rules still win on project matters.

**Workspace souls**

- A repo agent definition (`.claude/agents/<name>.md`) becomes a soul `ws/<name>`. Spawning with role `<name>` starts the agent in that repo with that soul. Souls are copies with the source sha stored; the shipped arsenal is never written.

**CLI**

- `agentnet adopt scan --dir D [--static]`, `adopt plan --scan ID [--accept all|recommended]`, `adopt apply --plan ID [--confirm-global]`, `adopt rollback [RUN] [--force]`, `adopt runs`. `rollback` and `runs` work with the server down.

**Other**

- `AGENTNET_NO_DIRECTOR_START=1` starts the server without spawning the director (for scratch and test runs).
- Preview footer buttons stack on narrow screens (380 px and below).

See [Adopt an existing workspace](docs/director.md#adopt-an-existing-workspace).

## 0.4.6

New releases show up within about 10 minutes, and you can check by hand.

- The release check runs every 10 minutes instead of every 6 hours. It sends the last ETag, so GitHub answers "not changed" (304) almost every time, and those answers do not count toward GitHub's rate limit.
- An open page refreshes its update status every 10 minutes too.
- **Settings → Updates** shows the current version, the newest known release and when it was last checked, with **Check now** and **Update now**. Before, a check could only be forced from the update pill, which only appears once an update is known.
- Hooks page: hook commands with a quoted script path (`node '/path/hook.js'`) no longer show a stray quote in the name, and arguments after the script no longer replace its name.

## 0.4.5

Talk to any agent as yourself, see its terminal live, and get the director back after `/exit`.

**Chat tab: one live timeline**

- The Chat tab of every agent, the director included, shows agentnet messages and the agent's terminal activity together: your prompts, its answers, and its tool steps as short rows ("Running tests", "Editing App.vue"). Filter by All, Messages or Terminal. Text passes through the same secret redaction as the rest of agentnet.
- Message box with two modes. **You** types straight into the agent's terminal as you. **agentnet message** sends an info, task or question as root, as before. The director only has **You**.
- An agent that runs outside agentnet's tmux windows shows why the box is off.
- While Chat is open, the panel folds its action rows away so the timeline gets the room; on a phone the sheet opens almost full height.

**Director: resume and reset**

- After `/exit`, the director card says "Not running" with **Resume director**, which reopens the last conversation (`claude --resume`) in the same folder, and **Start fresh**. If the old conversation file is gone, it starts fresh and says so. The map node does the same.
- New **Settings** page with **Reset director** (two-step confirm). It stops the director, writes a backup line to `<home>/data/director-resets.jsonl`, forgets it, and shows the first-run setup again. Agents, teams, tasks, scores and conversation files are kept.

## 0.4.4

Open window on the director always works, and agents keep their task lists honest.

**Director window**

- Open window finds the director wherever it runs: the `agentnet-root` tmux session, the old `agentnet-director` session from 0.4.1 (renamed to `agentnet-root` on its own), or any tmux pane that holds the director's process.
- A director you started in a terminal agentnet cannot open (and no terminal app found): Open window offers "Move the director into an agentnet window". It stops the director and starts it again in the same folder, inside its own window. Resume the old conversation with `/resume`.
- A director that is gone shows "Not running" with a Start director button. It starts the director where it last ran and opens the window. Terminals inside Cursor, VS Code, iTerm2, Ghostty, Warp and WezTerm are recognised.

**Task discipline**

- Five strict task rules, all on by default: done needs a started task, work needs a task in progress, one task in progress at a time, no "done" report with open tasks, and a grade penalty for skipped steps (the raw grade is kept). Each rule has a switch in `<home>/config/task-discipline.json`; `AGENTNET_TASK_STRICT=0` turns them all off. See `docs/task-discipline.md`.
- A discipline score per agent and per day, on the agent panel and a new Scores page with a daily trend. `agentnet discipline` prints it.

**Requirements**

- Claude Code 2.1.293 or later (2.1.318+ recommended). `agentnet doctor`, `agentnet init` and the plugin warn on an older version.

## 0.4.3

Update now works when agentnet runs in the foreground.

- If you started agentnet with `agentnet serve` (or an agent started it in a background shell), Update now on the update card is no longer greyed out. The updater installs the new version, stops the old server, and starts the new one on the same port with the same settings. If the new version does not come up, the old one is started again.
- In foreground mode the card says so, and suggests `agentnet install-service` to keep agentnet running after a reboot.

Coming from 0.4.2 in the foreground: run `agentnet update` in a terminal once. The server needs to start on 0.4.3 before the page can update it. A service install (launchd or systemd) updates from the header pill as before.

## 0.4.2

Fixes from a fresh install.

- "Start director for me" now starts the director in the tmux session that "Open window" looks for. Before, Open window failed with "no tmux session".
- A director you started in your own terminal: "Open window" brings that terminal app to the front, or says where the director runs, instead of a raw error.
- First-run setup: a "Choose…" button opens the system folder dialog (macOS, and Linux with zenity). Typing the path still works.
- Shipped hooks (prompt triage, usage guard, task guard) now show their runs on a fresh install, without a hook catalog file.

## 0.4.1

- Agent cards on the map show what the agent is doing now. The status line follows the newest signal (tool use in plain words, such as "Running tests" or "Editing App.vue"), and turns into "Idle · last: …" after a minute without activity. Before, a task title could stay on the card for several minutes while the agent was doing something else.
- Blocked agents, open owner checks and agents waiting for a reply show that first.
- The Linux test for the systemd update mode no longer fails in CI.

## 0.4.0

Update from the web app, a guided first run, ready-made hooks, and checks that wait for you.

### Update in one click

- A pill in the header shows when a newer release is out. Its sheet shows the notes, then runs the update with live progress: fetch, build, restart, reconnect.
- If the build or health check fails, agentnet rolls back to the version you had. Your data stays.
- Terminal users: `agentnet update` (add `--check` to only look, `--yes` to skip the prompt). Auto update is opt-in.

### First run

- With no director yet, the board shows a "Set up your director" card. It walks you through the folder, the start command (or "Start director for me"), a live check that turns green, and optional starter hooks.
- `agentnet init [dir] [--start]` does the same from the terminal.
- A clear message when `bun` is missing, instead of a bare error.

### Hooks

- The gallery has 25 ready-made hooks, including agentnet's own (prompt triage, usage guard, task guard, skill router, context warning).
- A Starter set adds 11 recommended hooks with one confirm and one backup of settings.json. Hooks already present are skipped.
- Prompt triage now runs through Claude Code itself (`claude -p` with Haiku). No API key needed: agentnet works on your Claude Code subscription only.
- A tip on the Agents page when prompt triage is off, or when Claude Code is not logged in.

### Agents and teams

- Every new agent and team states a goal: what "done" looks like. The panel shows it and hints "Goal reached? Review and close" when all tasks are done.
- Owner checks: an agent asks you a plain question with its own answer buttons ("Yes, it's there" / "No button"). It waits in amber on the board, even after the agent is closed. Your answer goes back to the director.
- Background jobs show a plain-English sentence ("Waits for the render batch to finish") instead of a cut-off command, on the map and in the panel.
- New agents appear straight in their team. Your zoom and pan stay put during live updates. The director card fits its text.
- A team with a lead is never auto-joined; only an explicit `--team` joins it.

### Look

- New logo and favicon: a ring hub with a live agent.

## 0.3.0

A redesigned web app, a smarter Agents map, and controls to run, stop and close agents from the panel.

### New look for five pages

- Usage, Scores, Trails, Hooks and Routing are now cards in one shared grid. Related numbers sit together.
- Routing roles are one table. Hooks shows failing events first, in a stable order.
- Agent and team panels share one side panel with the same header, spacing and close button.
- One set of colours and spacing for light and dark.

### Agents map

- Teams show their members as a tree: the lead on top, a trunk line to each group, no stacked lines.
- Cards wrap to new rows and glide to their new place when the layout changes.
- Each card shows the agent's model and version (for example "sonnet 5.5") next to its context use.
- A running task wins over tool chatter on the card line. Cards grow at once and shrink only after a calm moment.
- Team headers show a stack of member icons, the team's purpose and what it is doing now.
- Subagents, background shells and monitors appear as small rows under their agent. Rows still running after an hour are dimmed.
- The map fills the window and fits to view on load.

### Agent controls

- The side panel lists an agent's schedules and monitors, with a Run now button.
- Run now shows the job as running at once, refuses a second run, then reports the last result.
- Stop interrupts the agent. Close ends it. Close asks first, in a red card that says what will happen.
- Every stop, close and run now sends the boss a short notice and is logged.

### Hierarchy rules

- A member of an active team with a lead is reached through that lead. Teammates and the lead still talk freely.
- When a lead is set, changed or removed, members get the right boss automatically.

### Spawning

- `spawn` now picks model, effort and persona itself when you leave them out. Your own values always win.
- `spawn` also infers the role from the job text, picks the next free name, and joins the team for the same project.
- A team created this way has no lead until you name one, and an explicit boss is kept.
- `agentnet plan-spawn` (also an MCP tool and `/v1/admin/plan-spawn`) shows where a new agent would land and why. It changes nothing.
- The auto-compact window is a setting in the panel. It applies to new spawns.
- A spawn is refused in reserve mode.

### Accessibility

- Every fold, card and map row opens from its whole header and works with the keyboard.
- Folds animate height and padding together. Controls state what they open.
- Heading order and axe findings fixed across the new pages.

### Access

- New opt-in `AGENTNET_TRUST_PROXY=private`: a reverse proxy on the same machine can pass clients from your LAN or tailnet as local users. Off by default.

### Fixes

- Pages keep their old layout while they fade out, so nothing jumps on page change.
- Hooks event cards open downwards only and never get wider.
- The auto-compact window now survives spawn intact.
- Map links in wrapped rows drop through the nearest clear gap.
- A finished task list shows no progress bar, so an idle agent no longer looks busy.
- The recent message strip shows the message itself on two lines, and the full text on tap.
- Cron sources for the Schedules section are opt-in (`AGENTNET_JOBS_JSON`, `AGENTNET_ALL_CRON`). Admin notices name `AGENTNET_OWNER_NAME`, default "The owner".
- The map snaps to its layout while you resize the window, so clusters never overlap.
- Routing folds use the full card width. The Search snippet height animates.

## 0.2.0

First public release. agentnet is a local network for Claude Code agents: names, a boss, task lists, messages and a live view.

- Core service on `127.0.0.1:3096` with a SQLite store, an event log and a liveness sweep.
- `/v1/*` HTTP API with agent tokens, a loopback root and the `Agentnet-Api: 1` header. See `docs/api.md` and `spec/openapi.yaml`.
- Claude Code plugin, shell scripts and the `agentnet` CLI (`install/` templates; nothing is installed for you).
- `agentnet migrate-from-server-os` and `agentnet export-legacy` for moving data in and out of a Server OS install.
- Web app served at `/` (Vue 3): Agents map and cards, Usage, Scores, Trails, Search, Hooks, Routing and Personas.
  It can be embedded in an iframe; see `docs/embed.md`.
- Background jobs, persona catalogue (arsenal), model routing and hooks routes live in agentnet itself.
- The Hooks page reads its catalogue from `$AGENTNET_HOME/config/hook-catalog.json` (`docs/hook-catalog.example.json`).
- Scores use `owner_rounds`. The column's old Server OS name is only read when migrating a Server OS file.
- Panel reads of job output files and hook logs, and every panel write, need root (loopback without proxy headers, or the root token).
