import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "./envfile";

export const HOME = homedir();
export const VERSION: string = (JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version: string }).version;
/** Data folder. AGENTNET_HOME wins; default ~/.local/share/agentnet (macOS and Linux). */
export const ROOT = process.env.AGENTNET_HOME ?? join(HOME, ".local", "share", "agentnet");
loadEnvFile(join(ROOT, "config", "env")); // host-only settings (root session name, usage file, hook log dir); env vars win
export const DIRS = ["config", "data", "logs", "run", "trails", "bgjobs"] as const;
export const dir = (d: (typeof DIRS)[number]) => join(ROOT, d);
export const PORT = Number(process.env.AGENTNET_PORT ?? 3096);
export const HOST = process.env.AGENTNET_HOST ?? "127.0.0.1";
