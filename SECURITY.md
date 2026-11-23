# Security

## Reporting a problem

Report vulnerabilities privately through GitHub security advisories: open the **Security** tab of this repository and choose
**Report a vulnerability**. Please do not open a public issue for a security problem. You can expect an answer within a few days.

## Trust model

agentnet is built for one machine and one owner. Every API request needs a credential. A request from the machine itself
gets no rights for being local. Only `/v1/health` and the sign-in page answer without one.

- **Agents use tokens.** Every agent call sends `Authorization: Bearer <token>`. An unknown or revoked token is refused
  (401), and a retired agent's token never works again.
- **Root uses `run/root.token`.** The server writes it at first start. The root session reads it the same way agents read
  theirs.
- **The web app needs a sign-in.** `agentnet login`, run on the machine, prints a one-time link: one use, valid 60 s. The
  first start prints one too. The link becomes a session cookie (`HttpOnly`, `SameSite=Strict`, 30 days, stored hashed).
  Scripts can send `run/panel.token` instead.
- **Panel writes are root only.** Changing agents, hooks, settings or updates needs the panel or root token, or a signed-in
  session from the same origin. Another agent's token can read the panel but never write.
- **Never bind it publicly.** The default bind is `127.0.0.1`. agentnet refuses a public address and accepts loopback,
  private ranges and tailnet addresses only. Do not put it behind a public reverse proxy. If you embed the web app,
  forward only from a trusted host on the same machine or network, and drop `Authorization`, cookies and proxy headers
  on the way (`docs/embed.md`).
- **Nothing written outside its folder.** agentnet writes only under `$AGENTNET_HOME`. Your `~/.claude` is only read
  (by the import scan). The only exception is a path you set yourself in an env var such as `CLAUDE_SETTINGS_FILE`, and
  the server lists those at every start. The Hooks page edits `claude/base/settings.json` inside the folder, root only,
  with a backup first.

## Tokens and file modes

| File | Mode | Who uses it |
|---|---|---|
| `run/` | 0700 | The server's own folder |
| `run/root.token` | 0600 | Root's agent calls, panel writes |
| `run/panel.token` | 0600 | Scripts that call the panel routes; `agentnet login` |
| `agents/<name>/` | 0700 | One folder per agent |
| `agents/<name>/token` | 0600 | That agent only |
| `accounts/<id>/oauth-token` | 0600 | The Claude login that agents start with |

API bodies never contain token values or token file paths. Login codes live in memory only, and sessions are stored as
hashes.

## House flags

Two settings bring back the old loopback trust on one machine. Both are off by default. Each one is logged as a warning at
every start and listed in `/v1/health` under `houseFlags`.

- `AGENTNET_PANEL_LOGIN=off`: the panel needs no sign-in from this machine, or from a LAN or tailnet client behind a local
  proxy when `AGENTNET_TRUST_PROXY=private` is set. Risk: any program running as you, or anyone on that network if you
  trust the proxy, can use the panel and its write controls.
- `AGENTNET_LOOPBACK_ROOT=on`: an agent call from this machine with no token, or an unknown one, acts as root. Risk: any
  local program running as you is root on the agent API. **Deprecated: removed in 0.8.** Local scripts must send
  `run/root.token`. The server warns at start, the web app shows a banner, and `/v1/health` counts the requests the
  fallback served since boot (`loopbackRootHits`), so you can see when your scripts have all moved.

## Can one agent read another agent's token?

agentnet guards tokens in layers:

1. Each agent's token sits in its own `agents/<name>/` folder (0700). The root and panel tokens stay in `run/` (0700).
2. An agent that runs on its own Claude config (`agents/<name>/claude/`) gets permission rules that deny the `Read` and
   `Edit` tools on `run/`, `accounts/` and every `agents/*/token`. The agentnet plugin reads the agent's own token in-process,
   not through a tool.
3. On the server side, a stolen agent token is only that agent: no root routes, no spawn, no panel writes, and at most 300
   writes a minute.

The limits:

- All agents run as the same OS user, and a 0600 file is readable by that user. A shell command such as `cat` is not
  reliably stopped by the permission rules, which cover Claude Code's file tools.
- Claude Code's Bash sandbox can deny reads, but turning it on also limits network access and writes outside the working
  directory, and neither can be fully opened again (checked on Claude Code 2.1.327). agentnet does not turn it on, so
  agents keep working as before.
- Agents that still run on your own `~/.claude` (before an account and an import exist) get none of the layer 2 rules.
- An agent's file tools may not edit its own transcripts, but a shell command can still rewrite them (the same one-OS-user
  limit). The server checks every upgrade proof against the agent's own transcript, which raises the cost of forging one; it
  is not a sandbox.
- Full isolation needs one OS user per agent. That is out of scope for agentnet.
