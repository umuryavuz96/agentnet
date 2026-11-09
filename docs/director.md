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
