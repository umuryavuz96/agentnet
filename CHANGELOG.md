# Changelog

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
