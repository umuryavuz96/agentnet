# Director setup

The director flow: you talk to one agent, the director. It answers chat and small jobs itself. For real feature work it forms a team, runs it over agentnet, grades the result and despawns the team.

```
you -> director (root agent) -> [triage] line -> inline | background agent | council team
                                                  council team: moderator + personas + integrators
```

## 1. Start the director

The quickest way is `bin/agentnet init` (add `--start` to run it in tmux), or the **Set up your director** card on the board. Both print or run the command below. By hand: start the server, then start a root agent in its own terminal.

```sh
bin/agentnet serve                     # terminal 1
cd ~/my-project && claude              # terminal 2: this session is the director
```

The root agent has the extra tools `spawn`, `despawn`, `list_agents`, `get_status` and `grade`. See the README for how a session becomes root.

`spawn` routes by itself. Leave out `model`, `effort` or `soul` and the service picks them from `scope`, `novelty`, `risk` (defaults 2, 2, 1), `need` and `ask`. A value you pass always wins. The reply and the agent's card carry the audit line (`mode=… model=… effort=… score=… reason=…`). In reserve mode the spawn is refused.

You can also reach the director from your phone. Claude Code's own channel plugins (for example Telegram) work in the same session. This is optional. agentnet does not need it.

## Where a new agent lands

`plan_spawn` (MCP, `agentnet plan-spawn`, `POST /v1/admin/plan-spawn`) tells you where a new agent would go. It changes nothing. `spawn` uses the same plan for every field you leave out, so `spawn` with only `job` and `project` gives the same result. Anything you pass yourself wins, and the reason line says "explicit".

- **Name**: the next free `<role>-N`. The role is yours, or inferred from the job: whole words of the job are matched against each role's keyword list (for example `doc`: readme, docs, typo; `qa`: test, screenshot, verify). The role with the most matches wins, a tie goes to the earlier role in the list, no match gives `default_role`. The reason line names the matched words.
- **Team and boss**: if an active team works on the same project, the agent joins it and its lead is the boss (no lead means root). Else if another live agent works on that project, a new team `<project>-dev` is created with both as members and that agent is the boss. Else no team and boss root.
- **Model, effort, persona and compact window**: from the routing and the compact-window setting described above.
- **Reasons**: one line per decision in the reply.

The rules are in `$AGENTNET_HOME/config/placement.json`: `team_by_project` (default true), `naming` (default `{role}-{n}`), `default_role`, `team_suffix` (default `-dev`) and `role_keywords` (a role you list replaces its default words). No AI call is made.

## 2. Add the triage hook

The hook runs before Claude sees each prompt. It asks a small model, through Claude Code, to classify the prompt and adds one `[triage]` line to the director's context.

```sh
bin/agentnet install-hooks            # prints the settings.json snippet, writes nothing
bin/agentnet install-hooks --write    # backs up settings.json, then adds the hook once
```

The hook needs `python3` and the `claude` command, logged in. It runs `claude -p` with no settings sources, so no hook (including itself) loads in the child call. Without a login it does nothing and never blocks your prompt. It fails open after a 7 second budget. Run `claude` once and log in if the Agents page says triage is skipping.

| Env var | Default | Meaning |
|---|---|---|
| `AGENTNET_TRIAGE_MODEL` | `haiku` | Model passed to `claude -p --model`. |
| `AGENTNET_TRIAGE_BUDGET` | `7` | Total seconds before it gives up. |
| `AGENTNET_TRIAGE_LOG` | `$AGENTNET_HOME/logs/triage.jsonl` | Log of each decision. `off` disables it. The Hooks page reads it. |
| `AGENTNET_TRIAGE_STUB` | none | A JSON object used instead of calling claude. For tests and dry runs. |

Try it without calling claude:

```sh
echo '{"prompt":"build a settings page"}' | AGENTNET_BIN=bin/agentnet python3 hooks/triage.py --self-test
```

To show the hook on the Hooks page, copy `docs/hook-catalog.example.json` to `$AGENTNET_HOME/config/hook-catalog.json`.

## 3. Read the `[triage]` line

```
[triage] kind=feature complexity=4 risk=1 route=team role=web-dev -> mode=normal model=sonnet effort=high score=6 ... soul=<id> soul_alts=<id>,<id> council=<angle>,<angle> integrators=web-dev | reason: ... | RULE: ...
```

| Field | Meaning |
|---|---|
| `kind` | chat, question, lookup, one-off, feature, ops or external. |
| `complexity` | 1 to 5. |
| `risk` | 0 none, 1 live app, 2 live data or money, 3 irreversible. |
| `route` | `inline`: the director does it. `background-agent`: delegate a small job. `team`: form a council. |
| `role` | The role that fits best. |
| after `->` | The output of `agentnet pick-model` (`model`, `effort`, `score`), then `soul` and `soul_alts` from `agentnet pick-soul`, then `council` and `integrators` for a team. |
| `reason` | Why, in a few words. |

For `external` jobs (send, publish, buy) the director asks you first.

## 4. How the director runs a council

For `route=team` the director follows [rules/council-teams.md](rules/council-teams.md):

1. Plan: `agentnet council <project> <team> "<job>" "<angles>" "<integrators>"`. It prints the model, effort and persona for each member and spawns nothing.
2. Spawn: run the same command with `--go`. The moderator `architect-1` starts first and reports to root. Council members debate in `docs/council/<nn>-<topic>.md`. Integrators build what the moderator decides.
3. Watch: the web app shows the team live. Agents message the moderator, the moderator reports to root.
4. Grade: when a job is done, the director reviews the result and records a grade with the `grade` tool.
5. Despawn: `agentnet despawn <name>` for each member. Agents are short-lived. A fresh agent continues from the handover note.

Rules for model choice are in [rules/model-routing.md](rules/model-routing.md). Point `AGENTNET_RULES_DIR` at your own copy to change them.

## Adopt an existing workspace

If your project folder already has Claude Code instructions, hooks or per-repo agents, pick **Adopt my workspace** in the first-run window (step 2). Two coordination systems on the same agents would clash, so adopting is a clean switch with a preview, a backup and an undo. **Clean** is the other choice: the director gets its own home folder and your project is attached with `--add-dir`. Nothing in the project is read or changed.

How adopt works:

1. **Scan.** The collector gathers signals (hooks, MCP servers, instruction lines, running agent panes, repo agent definitions). It never recognises tools by name and never reads `.env`, keys or tokens. The director reads the evidence in a read-only session: the plugin denies every tool except reading files inside the workspace and the two scan tools. **Basic scan** makes no model call.
2. **Review.** The findings show as cards. You choose per card: switch off a second message system, add repo agents as workspace souls, replace identity lines, or keep as is. Things only you can do (stop a tmux session, unload a launchd job) show as commands to copy. agentnet never runs them.
3. **Preview.** The plan lists every file with a real diff and every file it creates. The plan id is bound to Apply: if a file changed since the preview, Apply answers 409 and you preview again.
4. **Apply.** Everything touched is backed up first under `$AGENTNET_HOME/adopt/<runId>/`, then changed, then the scan session stops and the real director starts. If a step fails, the run rolls itself back.
5. **Undo.** Rollback restores the backups. A file you edited after Apply is kept and reported unless you force it. Rollback also removes the workspace souls the run created.

The director starts in your workspace in adopt mode. Your `CLAUDE.md` and rules still load. agentnet appends a precedence block (`assets/director/precedence-adopt.md`): the director is `root`, coordination goes through agentnet only, and repo rules still win on project matters.

Which `CLAUDE.md` files load, checked on Claude Code 2.1.322 with `claude -p` and marker lines:

| Launch mode | Working folder | Workspace `CLAUDE.md` | Project `CLAUDE.md` |
|---|---|---|---|
| adopt, scan | the workspace | loads | loads if it is the workspace folder |
| clean | `$AGENTNET_HOME/director` | not loaded | not loaded (`--add-dir` does not load it) |

`--add-dir` loads the added folder's `CLAUDE.md` only when `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` is set. Keep it unset for the clean director.

### Workspace souls

A repo's own agent definition (`.claude/agents/<name>.md`), or a stub that points at its `CLAUDE.md`, becomes a soul `ws/<name>` in `$AGENTNET_HOME/workspace/` (`catalog.json`, `roles.json`, `souls/<name>.md`). The shipped arsenal is never written. Spawning with role `<name>` (for example `agentnet spawn --role ios`) starts the agent in that repo with that soul. An explicit `--soul` or `--project` still wins. A name that is also a built-in role gets a soul but no role mapping. Souls are copies: the source file is read once and its sha stored.

### Where it lives

- State: `$AGENTNET_HOME/adopt/state.json`. Runs: `$AGENTNET_HOME/adopt/<runId>/` (`manifest.json`, `backup/`, folders 0700, files 0600, kept for the last 5 runs).
- Panel API (root only for writes): `GET /v1/panel/adopt`, `POST /v1/panel/adopt/scan|cancel|plan|apply|rollback|clean`. Agent API (root token, scan phase only): `adopt_facts`, `adopt_report`. See [api.md](api.md).
- CLI: `agentnet adopt scan --dir D [--static]` (`--static` skips the model and reads the files only), `adopt plan --scan ID [--accept all|recommended]` (prints the diffs; `recommended` skips high-risk findings), `adopt apply --plan ID [--confirm-global]`, `adopt rollback [RUN] [--force]`, `adopt runs`. The first three need the server running. `rollback` and `runs` read the backup folder directly, so they work with the server down. Rollback keeps files you edited after the apply unless you pass `--force`.
- Not done in v1: stopping other systems' tmux, launchd or cron jobs; migrating old messages; keeping souls in sync with their source files.

## Requirements

Claude Code 2.1.293 or later (2.1.318+ recommended). The plugin uses `$.tool.register` with `isDeferred` and `$.session.append` (added in 2.1.293); from 2.1.318 the `prompt.submit` attachments stay in the user turn. `agentnet doctor` and `agentnet init` check `claude --version`; the plugin logs one warning if the session is older.
