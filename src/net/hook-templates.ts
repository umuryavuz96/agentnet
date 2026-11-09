// Premade hook templates (config/hook-templates.json) and the checks every new hook goes through, template or custom.
// Data only: nothing here is fetched at runtime, and a missing or broken file gives an empty gallery.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const EVENTS = ["SessionStart", "SessionEnd", "Stop", "StopFailure", "SubagentStop", "PreCompact", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "PermissionRequest"] as const;
/** Events whose matcher means something (a tool name regex). Every other event runs for every occurrence. */
export const MATCHER_EVENTS: readonly string[] = ["PreToolUse", "PostToolUse", "PermissionRequest"];
export type Risk = "blocks" | "writes" | "network" | "read-only";

export interface HookTemplate {
  id: string; name: string; about: string; category: string; event: string; matcher: string | null; command: string; timeout: number;
  risk: Risk; requirements: string[]; source: { name: string; url: string; stars?: number; licence?: string };
  /** in the recommended "Starter set" for a fresh install */ starter: boolean;
  /** runs a script that ships with agentnet (the command used {{AGENTNET_DIR}}) */ own: boolean;
}
export interface HookSpec { event: string; matcher: string | null; command: string; timeout: number }

export class HookInputError extends Error { constructor(msg: string, readonly status = 400) { super(msg); } }

/** Risk from the command alone: network beats writes beats blocks beats read-only. */
export function deriveRisk(command: string): Risk {
  if (/\b(curl|wget|nc|ssh|scp)\b|https?:\/\//.test(command)) return "network";
  // a redirect to a file other than /dev/null or /tmp, a formatter that rewrites files in place, or a git command that writes refs
  if (/(?<![>&\d])>>?\s*(?!&|\/dev\/null|\/tmp\/)[^\s&]/.test(command) || /--write\b|\bgofmt -w\b|\b(sed|perl) -i\b|\btee\b|\bgit (add|commit|stash store|tag)\b/.test(command)) return "writes";
  if (/\bexit 2\b/.test(command)) return "blocks";
  return "read-only";
}

/** Check one hook and return it cleaned up. Throws HookInputError with a plain message. */
export function validateHook(input: { event?: unknown; matcher?: unknown; command?: unknown; timeout?: unknown }, maxCommand = 4096): HookSpec {
  const event = input.event;
  if (typeof event !== "string" || !(EVENTS as readonly string[]).includes(event)) throw new HookInputError(`event must be one of: ${EVENTS.join(", ")}`);
  let matcher: string | null = null;
  if (typeof input.matcher === "string" && input.matcher.trim()) {
    if (!MATCHER_EVENTS.includes(event)) throw new HookInputError(`${event} runs for every occurrence: leave the matcher empty`);
    matcher = input.matcher.trim();
    try { new RegExp(matcher); } catch { throw new HookInputError("matcher is not a valid regular expression"); }
  } else if (input.matcher != null && typeof input.matcher !== "string") throw new HookInputError("matcher must be text");
  const command = input.command;
  if (typeof command !== "string" || !command.trim()) throw new HookInputError("command is empty");
  if (command.length > maxCommand) throw new HookInputError(`command is longer than ${maxCommand} characters`);
  const t = input.timeout ?? 10;
  if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > 600) throw new HookInputError("timeout must be a whole number from 1 to 600 seconds");
  return { event, matcher, command, timeout: t };
}

/** The agentnet install dir (the repo that holds hooks/ and config/). AGENTNET_DIR overrides it, for tests. */
export const installDir = () => process.env.AGENTNET_DIR ?? join(import.meta.dir, "..", "..");
const PLACEHOLDER = /\{\{AGENTNET_DIR\}\}/g;
/** Put the install dir in for {{AGENTNET_DIR}}. Templates use it inside double quotes, so ", \\, $ and ` are escaped. */
export function resolveCommand(command: string, root = installDir()): string {
  const safe = root.replace(/[\\"$`]/g, (c) => "\\" + c);
  return command.replace(PLACEHOLDER, () => safe);
}

const FILE = () => process.env.AGENTNET_HOOK_TEMPLATES ?? join(import.meta.dir, "..", "..", "config", "hook-templates.json");
const RISKS: Risk[] = ["blocks", "writes", "network", "read-only"];
/** The shipped templates. A broken file or a bad entry is skipped, never thrown. */
export function templates(): HookTemplate[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(FILE(), "utf8")); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: HookTemplate[] = [], seen = new Set<string>();
  for (const e of raw as Record<string, unknown>[]) {
    try {
      const own = typeof e.command === "string" && e.command.includes("{{AGENTNET_DIR}}");
      const s = validateHook({ ...e, command: typeof e.command === "string" ? resolveCommand(e.command) : e.command }, 1024 + (own ? 2048 : 0));
      const src = e.source as { name?: unknown; url?: unknown; stars?: unknown; licence?: unknown } | undefined;
      if (typeof e.id !== "string" || !e.id || seen.has(e.id) || typeof e.name !== "string" || typeof e.about !== "string" || typeof e.category !== "string") continue;
      if (!RISKS.includes(e.risk as Risk) || !Array.isArray(e.requirements) || typeof src?.name !== "string" || typeof src.url !== "string") continue;
      seen.add(e.id);
      out.push({ id: e.id, name: e.name, about: e.about, category: e.category, ...s, risk: e.risk as Risk, requirements: (e.requirements as unknown[]).map(String), source: { name: src.name, url: src.url, ...(typeof src.stars === "number" ? { stars: src.stars } : {}), ...(typeof src.licence === "string" ? { licence: src.licence } : {}) }, starter: e.starter === true, own });
    } catch { /* bad entry: skip */ }
  }
  return out;
}
