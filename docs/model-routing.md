# Model routing

`agentnet pick-model` (scripts/pick-model.sh) picks a model and an effort level for an agent from a small rubric. The same inputs always give the same answer, and every decision is appended to `$AGENTNET_HOME/logs/model-routing.jsonl`.

```
agentnet pick-model --role backend-1 --scope 3 --novelty 2 --risk 1 [--ask "<words>"] [--expect low|normal|high] [--explicit haiku|sonnet|opus|fable] [--usage <pct>]
```

Output: `mode=<m> model=<alias> effort=<level> score=<n> usage=<pct> reason=<short>`. Warnings go to stderr.

## Principles

1. Tune effort first. Change the model tier only when effort is not enough.
2. Match the model to the cost of a mistake. Roles that only read (lookup, qa, research) go low. Roles that write code never run on Haiku. Risky or irreversible work gets a floor.
3. An explicit model from the caller wins, except when the reserve block is on.

## Rubric

| Input | Values | Points |
|---|---|---|
| scope | 1 one file ... 5 many systems | (scope-1) x 1 |
| novelty | 1 done before, 2 some unknowns, 3 new or ambiguous | (novelty-1) x 2 |
| risk | 0 none, 1 live UI or app, 2 live data, money or security, 3 irreversible | risk x 2 |
| expectation | low (-2), normal (0), high (+3); set by `--expect` or by keywords in `--ask` | as listed |
| role default | per role, see `roles` in the config | as listed |

Score to model: up to 1 haiku/low, 2-3 sonnet/medium, 4-6 sonnet/high, 7-9 opus/medium, 10-12 opus/high, 13 and up fable/high.

Floors: writing roles never get Haiku. Risk 2 or more gets at least sonnet/high (not in eco). Risk 3 gets at least Opus (eco caps it and warns).

Tie-breaks: a score on a band edge takes the lower band. `--expect` beats `--ask` keywords. High keywords beat low ones.

## Usage modes

Usage is off by default: without a usage source the mode is always `normal`. To turn it on, point `AGENTNET_USAGE_FILE` at a JSON file that you keep fresh:

```json
{"last": {"fetchedAt": 1760000000, "windows": [{"key": "five_hour", "pct": 40, "resetsAt": 1760003600, "hours": 5}, {"key": "seven_day", "pct": 62, "resetsAt": 1760500000, "hours": 168}]}}
```

`fetchedAt` and `resetsAt` are Unix seconds. A file older than `usage.stale_hours` (default 3) is ignored. `--usage <pct>` overrides the file.

| Mode | Default trigger | Rules |
|---|---|---|
| normal | below 60 | The rubric as is. |
| careful | 60-79 | Drop one effort level. Fable becomes Opus unless explicit. Opus only at score 10 or more. |
| eco | 80-89 | Builders max Sonnet, light roles Haiku, effort max medium. Explicit models still win, with a warning. |
| reserve | 90 and up (fixed minimum) | Exit 2: no new heavy work. |

To lift the reserve block for 2 hours, set `AGENTNET_USAGE_OVERRIDE` to a file path and touch that file. Eco rules then apply. The override is off when the variable is unset.

## Config

The tunables live in `$AGENTNET_HOME/config/model-routing.json` (override: `MODEL_ROUTING_FILE`). A missing file means built-in defaults, with no warning. An invalid file warns on stderr and falls back to the defaults. `pick-model --write-default-config` writes the full default file.

| Field | Meaning |
|---|---|
| `points.scope_step`, `novelty_step`, `risk_step` | points per input step |
| `expect.low`, `normal`, `high` | expectation points |
| `expect_keywords.high`, `low` | words in `--ask` that set the expectation |
| `roles.<name>` | `points`, `writes` (never Haiku), `light` (Haiku in eco), `description` |
| `bands.value[]` | `{max_score, model, effort}`, ascending, the last `max_score` is null |
| `floors.risk_sonnet_high`, `risk_opus` | risk levels for the two floors |
| `usage.window` | `max`, `five_hour` or `seven_day` |
| `usage.stale_hours` | ignore older usage files |
| `usage.modes.<mode>` | thresholds and limits per mode; `reserve.min_pct` cannot go below 90 |

Validation: models are haiku, sonnet, opus or fable; efforts run from low up; bands ascend; careful is below eco, and eco is at most reserve.
