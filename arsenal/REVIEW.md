# Security review

2026-11-03. Automated regex scan of every candidate file (drop patterns: curl|sh, prompt-injection phrases, conceal-from-user, disable safety, skip-permissions, base64 exec, exfil wording, send-secrets-to-URL, exfil sink hosts, invisible unicode) plus flag patterns (curl/wget, sudo, rm -rf, URLs, eval) reviewed manually.

Candidates 692; dropped 4; deduped 243; kept 449.

## Dropped

- wshobson/agents:plugins/social-publishing/agents/social-publishing-publisher.md - manual: installs third-party skill (npx skills add) + external paid API (getsocialclaw.com)
- VoltAgent/awesome-claude-code-subagents:categories/07-specialized-domains/healthcare-admin.md - curl|sh pipe-to-shell
- VoltAgent/awesome-claude-code-subagents:categories/10-research-analysis/scientific-literature-researcher.md - manual: wires external MCP SSE server (bgpt.pro), contacts third-party service
- rohitg00/awesome-claude-code-toolkit:agents/specialized-domains/robotics-engineer.md - disable safety

## 2026-11-07 council personas (researcher-1)

Added 11 personas: 9 vendored from Donchitos/Claude-Code-Game-Studios (36289 stars, MIT, commit 05ad7c8a5b8a: game-designer, systems-designer, economy-designer, level-designer, narrative-director, art-director, creative-director, sound-designer, producer) and 2 in-house (critic-devils-advocate, player-advocate).

Review: every file read by hand and regex scanned (curl/wget/pipe-to-shell/sudo/rm -rf/eval/base64/URLs/ignore-previous/conceal/disable/exfil/token/secret/password/invisible unicode). Result: clean. Only hits were harmless ("secret" = hidden game content in level-designer; "begin with the verdict token" output format in art-director, creative-director, producer). Notes: (1) the source personas carry a "collaborative consultant, ask first, get approval before writing files" protocol, so they may ask questions before answering in a council; (2) producer frontmatter lists Bash and creative-director/producer say model opus, but spawn.sh sets tools and model, the persona text is what is used; (3) not vendored: writer, ux-designer, world-builder, engine-specific and programmer agents (not requested).
Gaps without popular source: critic / devil's advocate and player advocate. Written in-house, advisory only, no tools beyond Read/Glob/Grep/WebSearch.
New roles in roles.json: game-designer, narrative-designer, level-designer, economy-designer, critic, player-advocate, producer, art-director, sound-designer.
