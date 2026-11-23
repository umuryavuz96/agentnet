// The one-folder layout (docs/internal/one-folder/PLAN.md §1): where each agent's files live under the home.
// No server imports, so the CLI migration and the server share it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config";

/** agents/<name>: the agent's own folder (token, records, Claude config). */
export const agentDir = (name: string, root: string = ROOT): string => join(root, "agents", name);
/** agents/<name>/token: where a new spawn writes the agent's token. */
export const agentTokenFile = (name: string, root: string = ROOT): string => join(agentDir(name, root), "token");
/** agents/<name>/records: handovers and other per-agent records. */
export const agentRecordsDir = (name: string, root: string = ROOT): string => join(agentDir(name, root), "records");
/** run/agentnet/<name>.token: the token path before the one-folder layout. */
export const legacyTokenFile = (name: string, root: string = ROOT): string => join(root, "run", "agentnet", `${name}.token`); // one-folder fallback: remove after 0.7
/** records/<name>: the records path before the one-folder layout. */
export const legacyRecordsDir = (name: string, root: string = ROOT): string => join(root, "records", name); // one-folder fallback: remove after 0.7
/** souls/ once the migration made it, otherwise run/souls/, so an unmigrated store keeps working. */
export const soulsDir = (root: string = ROOT): string => existsSync(join(root, "souls")) ? join(root, "souls") : join(root, "run", "souls"); // one-folder fallback: remove after 0.7
