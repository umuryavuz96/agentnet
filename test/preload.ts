// Old tests spawn agents and teams without a goal: the goal rule is off here. Tests of the rule set AGENTNET_REQUIRE_GOAL=1 themselves.
process.env.AGENTNET_REQUIRE_GOAL = "0";
process.env.AGENTNET_TASK_STRICT = "0"; // strict task rules (docs/task-discipline.md) are off by default in tests; test/discipline.test.ts turns them on
