# Attribution

The persona catalogue in `arsenal/` is a vendored copy of agent persona files (Markdown only, no scripts or hooks) from the
open source projects below. Each folder keeps its upstream `LICENSE`. Every file was read and scanned before it was kept; see
`arsenal/REVIEW.md` for what was dropped and why, and `arsenal/SOURCES.md` for the commit of each copy.
`arsenal/catalog.json` records the source repository, commit URL and licence of every persona.

| Folder | Project | Licence |
|---|---|---|
| `arsenal/affaan-m-ECC` | [affaan-m/ECC](https://github.com/affaan-m/ECC) | MIT |
| `arsenal/addyosmani-agent-skills` | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | MIT |
| `arsenal/wshobson-agents` | [wshobson/agents](https://github.com/wshobson/agents) | MIT |
| `arsenal/VoltAgent-awesome-claude-code-subagents` | [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) | MIT |
| `arsenal/davepoon-buildwithclaude` | [davepoon/buildwithclaude](https://github.com/davepoon/buildwithclaude) | MIT |
| `arsenal/Donchitos-Claude-Code-Game-Studios` | [Donchitos/Claude-Code-Game-Studios](https://github.com/Donchitos/Claude-Code-Game-Studios) | MIT |
| `arsenal/rohitg00-awesome-claude-code-toolkit` | [rohitg00/awesome-claude-code-toolkit](https://github.com/rohitg00/awesome-claude-code-toolkit) | Apache-2.0 |
| `arsenal/in-house` | this repository | MIT (see `LICENSE`) |

## Apache-2.0 notice

The files in `arsenal/rohitg00-awesome-claude-code-toolkit` come from rohitg00/awesome-claude-code-toolkit and are licensed
under the Apache License 2.0 (`arsenal/rohitg00-awesome-claude-code-toolkit/LICENSE`). The upstream project ships no `NOTICE`
file. Changes made here: the files were copied unchanged, and only their selection and the catalogue entries that point at them
are new. The Apache licence applies to those files only; the rest of agentnet is MIT.

## MIT notice

Each MIT-licensed folder carries the copyright line and permission notice of its upstream project in its own `LICENSE` file,
as the licence requires. Those notices stay with the files and must be kept if you copy them.

## Removing a source

Delete its folder and its entries from `arsenal/catalog.json` and `arsenal/sources.json`. Nothing else depends on it.
