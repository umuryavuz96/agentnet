# Security

## Reporting a problem

Report vulnerabilities privately through GitHub security advisories: open the **Security** tab of this repository and choose
**Report a vulnerability**. Please do not open a public issue for a security problem. You can expect an answer within a few days.

## Trust model

agentnet is built for one machine and one owner.

- **Loopback is root.** A request that comes from the machine itself, with no proxy header such as `X-Forwarded-For`, acts as
  root. Anything that can open a local socket as your user can do the same, so only run agentnet on a machine you trust.
- **Agents use tokens.** Every other agent call needs its own `Authorization: Bearer <token>`. A retired agent's token is refused.
- **Root-only routes.** Panel writes, the admin routes, job output files and hook logs need root: loopback, or the live root
  agent's token. A request that carries a proxy header is never treated as loopback.
- **Never bind it publicly.** The default bind is `127.0.0.1`. agentnet refuses a public address (it accepts loopback, private
  ranges and tailnet addresses only). Do not put it behind a public reverse proxy. If you embed the web app, forward only from
  a trusted host on the same machine or network, and drop `Authorization`, cookies and proxy headers on the way (`docs/embed.md`).
- **Hooks write your Claude settings.** The Hooks page edits `~/.claude/settings.json` (a backup comes first). Only root can do it.

## Secrets

Tokens live in files under `$AGENTNET_HOME` with owner-only permissions. API bodies never contain token values or token file paths.
