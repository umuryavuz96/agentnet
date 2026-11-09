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

## Accepted risk

Any process of this user on this machine can act as root without a token. This is the same trust as before, where any such
process could read the admin key file. A LAN or tailnet caller never gets root without the root agent's token.

## SSE frames (`/v1/panel/stream`)

`hello`, `agent`, `gone`, `msg`, and `ping` every 15 s. The frame id is the event seq.

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
