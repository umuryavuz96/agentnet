# agentnet: notes for coding agents

- The running service serves the built UI from `web/dist`, not `web/src`. After any change under `web/`, run `bun run web:build` before you report done, then check the live page. A commit alone changes nothing on screen.
- Before done: `bun test`, typecheck, `bun run web:build`, and a screenshot of the live page.
