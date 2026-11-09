# Changelog

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
