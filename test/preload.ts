// Old tests spawn agents and teams without a goal: the goal rule is off here. Tests of the rule set AGENTNET_REQUIRE_GOAL=1 themselves.
process.env.AGENTNET_REQUIRE_GOAL = "0";
process.env.AGENTNET_TASK_STRICT = "0"; // strict task rules (docs/task-discipline.md) are off by default in tests; test/discipline.test.ts turns them on
// Auth house flags (src/core/auth.ts) are off by default; a test that turns one on gets it cleared after itself.
import { afterEach, beforeEach } from "bun:test";
delete process.env.AGENTNET_PANEL_LOGIN; delete process.env.AGENTNET_LOOPBACK_ROOT;
afterEach(() => { delete process.env.AGENTNET_PANEL_LOGIN; delete process.env.AGENTNET_LOOPBACK_ROOT; });
// Tests never read the live Claude usage of the shell they run in (an agent shell exports these; in reserve mode every routed spawn was a 409).
// A test file that sets and then deletes USAGE_GUARD_FILE must not let the next file fall back to ~/.claude: it is put back before each test.
const NO_USAGE = "/nonexistent/agentnet-test-usage.json";
delete process.env.AGENTNET_USAGE_FILE; delete process.env.AGENTNET_USAGE_OVERRIDE;
process.env.USAGE_GUARD_FILE ??= NO_USAGE;
beforeEach(() => { process.env.USAGE_GUARD_FILE ??= NO_USAGE; });
