# Model routing rules

The full rubric, the tunables and the usage modes are in [../model-routing.md](../model-routing.md). This page is the short version that agents follow when they spawn other agents.

1. Before every spawn, run `agentnet pick-model` and pass its `model` to `agentnet spawn --model`. Quote the output line in your report.
2. The user's explicit model wins. Pass their words with `--ask` so `pick-model` can see them.
3. Tune effort before you change the model tier.
4. Match the model to the cost of a mistake. Roles that only read (lookup, qa, research) go low. Roles that write code never run on Haiku. Risky or irreversible work gets a floor.
5. Plan with the strongest model, build with a cheaper one. The planner writes an exact spec (files, functions, acceptance tests). A cheaper model builds only from such a spec.
6. Keep agents short-lived. After a big task, write a handover note and despawn. A fresh agent continues from the note.
7. Usage modes slow things down as the usage windows fill. In `reserve` mode start no new heavy work.

Pick a persona the same way: `agentnet pick-soul --role <role> --need "<specialty keywords>"` and pass the result to `agentnet spawn --soul`. Check the `alts` it prints before you spawn.
