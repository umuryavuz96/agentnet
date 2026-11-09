# Contributing

Thanks for helping. agentnet is small on purpose: keep changes small and tested.

## Set up

```sh
bun install
bun test                 # all tests; they use a temp AGENTNET_HOME and never touch real data
bun run typecheck        # server and plugin types
bun run web:check        # web app types
bun run web:build        # builds web/dist, which the service serves at /
```

Run the service for manual checks on a spare port with a throwaway home, so you never touch your own data:

```sh
H=$(mktemp -d) AGENTNET_HOME=$H AGENTNET_PORT=3196 AGENTNET_SWEEP=0 bun run start
```

`AGENTNET_SWEEP=0` turns off the liveness sweep and the session reaper. Always set it for a test or demo instance.

## Rules

- Tests: new behaviour gets a test. A test that sets an environment variable clears it afterwards.
- No personal data in code, comments, tests or docs: no names, hostnames, chat ids or LAN addresses. Use `10.0.0.5`,
  `100.64.0.10` and `/home/x/` in fixtures.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): …`, `fix(scope): …`, `docs: …`,
  `chore: …`, `test: …`.
- UI changes come with a screenshot at 390 and 1280 px.
- Keep the web app's calls on relative `v1/panel/*` URLs so one build works at `/` and under a path prefix.
