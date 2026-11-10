# agentnet API v1

Every response carries `Agentnet-Api: 1`. `GET /v1/health` returns `{name, version, api, minClientApi, features}`.
The paths are listed in `spec/openapi.yaml`. The old `/api/v1/agentnet/*` paths keep working and share the same handlers.

## Auth per route group

| Group | Rule |
|---|---|
| `/v1/health` | open |
| `/v1/agent/*` | agent token (`Authorization: Bearer <token>`), or a request from this machine (loopback) = root |
| `/v1/admin/*` | root: a loopback request, or the live root agent's token |
| `/v1/panel/*` GET | open on the bound address, read-only; bodies never hold token values or token file paths. Exceptions, root only (403 for any other caller): `/v1/panel/bgjobs/{id}/file` (job output files) and `/v1/panel/hooks/fires` (hook log lines) |
| `/v1/panel/*` POST | root only: a loopback request, or the live root agent's token. Others get 403 |

A token of a retired agent is always refused with 401 `agentnet: revoked agent token`. It never falls back to loopback root.
A LAN or tailnet caller without a valid token gets 401 on agent and admin routes and 403 on panel writes.

## Spawn routing (`POST /v1/admin/spawn`)

Body: `name`, `job`, `boss`, `project`, `team`, and optional `model`, `effort`, `soul`, `scope` (1-5, default 2), `novelty` (1-3, default 2),
`risk` (0-3, default 1), `need` (persona keywords) and `ask` (the owner's words, read for expectation keywords). When `model`, `effort` or `soul`
is missing, the service picks it (the same rubric as `agentnet pick-model` and `pick-soul`); a value you give always wins. The 201 reply adds
`model`, `effort`, `soul`, `audit` (`mode=… model=… effort=… score=… reason=…` and `soul=…` lines) and `warnings`. The audit line is kept on the
agent record. In reserve mode (usage at 90% or more) the spawn is refused with 409 `Reserve mode`. Members (`kind: "member"`) are not routed.
`name`, `boss`, `team` and `project` are placed the same way (see "Where a new agent lands" in docs/director.md); the reply adds `name`, `boss`, `team`, `compact_window` (tokens) and `reasons`.
**Goal.** `goal` (8+ characters) is required for a new agent: the outcome that means it is done, not what it does (that is `job`). A missing or short goal
is refused with 422 `goal is required: what does done look like?`. Exempt: root, channel bots joining as `kind: "member"` (`agentnet-join.sh`), and the auto team
created by placement (it takes the spawning agent's goal). `AGENTNET_REQUIRE_GOAL=0` turns the rule off for old callers. The goal is stored on the agent
(`goal` in the snapshot and `GET /v1/agent/agents`) and shown in the agent panel. `POST /v1/agent/teams` needs `goal` the same way. `plan-spawn` accepts `goal` and ignores it.
`spawn-agent.sh --goal TEXT` and `council.sh --goal TEXT` pass it (council defaults to "Decision + integrated build for: <job>"); the MCP `spawn` tool lists `goal` as required.
`POST` or `GET /v1/admin/plan-spawn` (`job` needed) returns `{plan}` with the same fields and no side effects.

## Accepted risk

Any process of this user on this machine can act as root without a token. This is the same trust as before, where any such
process could read the admin key file. A LAN or tailnet caller never gets root without the root agent's token.

## SSE frames (`/v1/panel/stream`)

`hello`, `agent`, `gone`, `msg`, `check`, and `ping` every 15 s. The frame id is the event seq.

## Owner checks

A check is a thing only the owner can verify in the real world. It outlives the agent that asked, so the agent can be closed while it waits.

- `POST /v1/agent/checks {question, options?, detail?}`: an agent writes the question and 2-4 answer buttons `options: [{label, tone: good|bad|neutral}]` (label max about 5 words; none given = Works / Not yet). An agent asks for itself (MCP tool `ask_owner_check`); root may add `agent` (any name, also a despawned one). The same open question from the same agent returns the existing row.
- `GET /v1/agent/checks?state=pending|answered`: root sees all, an agent its own (MCP tool `list_checks`, root).
- `GET /v1/panel/checks?state=`: the list for the page.
- `POST /v1/panel/checks/{id}/resolve {option, note?}` (the label or index of one of the check's options; note is optional on every answer): a panel write (root only). It sends root a `report` from `owner`, subject `Owner answered "<label>": <question>`, with the note. It never spawns or closes anything: root decides. 409 when already resolved.
- The panel stream sends a `check` frame (whole row) on every create and resolve; the snapshot carries `checks` (pending plus those answered in the last 30 s).

## Errors

RFC 9457 `application/problem+json`: `{type, title, status, detail, trace_id}`.

## Bind check

agentnet refuses to start on `0.0.0.0`, `::`, public addresses or hostnames other than `localhost`. Allowed: loopback, RFC 1918,
tailnet `100.64.0.0/10` and `fd7a:115c:a1e0::/48` (set `AGENTNET_HOST`).

## Reverse proxies

A request counts as loopback only when the peer is 127.0.0.0/8 or ::1 **and** it has none of the headers `X-Forwarded-For`,
`Forwarded`, `X-Real-IP` or `Via`. A proxy such as Caddy or `tailscale serve` connects from 127.0.0.1 for every client, so
those requests never become root by address. Do not put agentnet behind a reverse proxy that strips these headers.
Behind a proxy, a root caller must send the root agent's token.

Open question (phase 5): Server OS will forward `/agentnet/*` requests. It must then pass the root token itself, because its
requests carry proxy headers. How it obtains and stores that token is not designed yet.

## Logging

`?token=` (the EventSource fallback) is never logged: the request log holds the path only, not the query string.

## Hook catalogue

The Hooks page names and describes hooks from `$AGENTNET_HOME/config/hook-catalog.json` (override: `AGENTNET_HOOK_CATALOG`).
It is a JSON array of `{ "match": "<regex source tested against the hook command>", "name", "about", "log"?, "script"? }`.
`log` is a JSONL file in `AGENTNET_HOOK_LOGS` that the hook appends to, and `script` is the script name shown on its fires.
Without the file every hook gets its script name and a line built from its event. See `docs/hook-catalog.example.json`.

## Hook templates and install

Templates ship in `config/hook-templates.json` (override: `AGENTNET_HOOK_TEMPLATES`). A broken file gives an empty gallery. Every route below is root only and writes through the same backup, validate and rollback path as the on/off switch.

| Route | Does |
|---|---|
| `GET /v1/panel/hooks/templates` | Templates with `state` (`available`, `installed`, `switched-off`) and `missing` (requirements not found on this machine). |
| `POST /v1/panel/hooks/install` | Body `{ "templateId" }` or `{ "custom": { event, matcher?, command, timeout? } }`, plus `dryRun: true` to return the settings fragment and write nothing. Returns `{ installed, backup, fragment, hooks, backups }`. 409 when the hook is already added (on or switched off), 400 with a plain message when validation fails, 404 for an unknown template. |
| `DELETE /v1/panel/hooks/{id}` | Remove a hook for good, on or switched off. 404 when not found. |

Risk is derived from the command: `network` (curl, wget, nc, ssh, http), else `writes` (redirect to a file outside /tmp, or an in-place formatter), else `blocks` (`exit 2`), else `read-only`. Custom hooks: event is one of the 10 Claude Code events; a matcher only on PreToolUse, PostToolUse and PermissionRequest and it must compile as a regex; timeout 1 to 600 s (default 10); command 1 to 4096 characters.

## Adopt workspace (0.5.0)

Panel (root only for writes): `GET /v1/panel/adopt` (phase, scanner, report, plan, runs), `POST /v1/panel/adopt/scan {dir, mode: director|static}`, `/cancel`, `/plan {scanId, picks:{findings:{id:"apply"|"skip"}, skipActions:[id]}}`, `/apply {planId, confirmGlobal}`, `/rollback {runId?, force?}`, `/clean {dir}`.
Admin (root agent token, scan phase only): `GET /v1/admin/adopt/facts`, `POST /v1/admin/adopt/report`. Apply answers 409 when the plan is not the current plan or a file changed since the preview.
