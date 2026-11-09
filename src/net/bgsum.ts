// One plain-English sentence for a background shell or monitor that came without a description: the job chip on the map
// and the side panel show it instead of the raw command. It is made by Claude Code itself (`claude -p --model haiku`),
// so it uses the subscription and never an API key. The command is redacted first: anything that looks like a secret
// never leaves this process. The raw command stays on the row as the fallback and the tooltip.
import { tmpdir } from "node:os";

const MAX_CMD = 400, MAX_WORDS = 12, MAX_CHARS = 70, TIMEOUT_MS = 40_000, PARALLEL = 2, CACHE_MAX = 300;

/** Replace anything that looks like a credential. Cheap and greedy: a wrong hit only makes the sentence vaguer. */
export function redact(cmd: string): string {
  return cmd
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1…$2")
    .replace(/\b(Authorization|Proxy-Authorization)(\s*[:=]\s*)(?:(Bearer|Basic|Token)\s+)?("[^"]*"|'[^']*'|[^\s"']+)/gi, "$1$2•••")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 •••")
    .replace(/\b([A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|AUTH|CREDENTIAL|COOKIE|SESSION)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2•••")
    .replace(/(--?(?:password|passwd|pass|token|secret|api-?key|auth|cookie|bearer)[= ]+)("[^"]*"|'[^']*'|\S+)/gi, "$1•••")
    .replace(/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1•••@")
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|glpat|xox[baprs]|AKIA|AIza|ya29|npm|hf)[-_][A-Za-z0-9_-]{8,}/g, "•••")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, "•••")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "•••")
    .replace(/\b(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{28,}\b/g, "•••")
    .replace(/\s+/g, " ").trim().slice(0, MAX_CMD);
}

/** The model's answer as one short line, or null when it is not usable. */
export function tidy(out: string): string | null {
  let s = (out.split("\n").map((l) => l.trim()).find(Boolean) ?? "").replace(/^["'`*\s-]+|["'`*\s]+$/g, "").replace(/^(summary|sentence)\s*:\s*/i, "");
  if (!s || /^(i |sorry|error|cannot|can't)/i.test(s)) return null;
  const words = s.split(/\s+/);
  if (words.length > MAX_WORDS + 3) s = words.slice(0, MAX_WORDS).join(" ");
  s = s.replace(/[.\s]+$/, "");
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS).replace(/\s+\S*$/, "");
  return s || null;
}

const PROMPT = (cmd: string) => `Describe in plain English what this shell command does, for someone who does not read shell. One sentence, at most 10 words and under 60 characters, no quotes, no trailing period, no file paths unless they are the point. Start with a verb such as Waits, Runs, Watches, Builds, Downloads, Copies. Reply with the sentence only.\n\nCommand: ${cmd}`;

/** Run Claude Code on the redacted command. Resolves to the sentence, or null on any failure. */
export async function askClaude(cmd: string, bin = process.env.AGENTNET_CLAUDE_BIN || "claude"): Promise<string | null> {
  try {
    const p = Bun.spawn([bin, "-p", "--model", "haiku", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands"], { stdin: new TextEncoder().encode(PROMPT(cmd)), stdout: "pipe", stderr: "ignore", cwd: tmpdir(), env: { ...process.env, AGENTNET_AGENT: "", AGENTNET_URL: "", AGENTNET_TOKEN_FILE: "" } });
    const timer = setTimeout(() => p.kill(), TIMEOUT_MS);
    const out = await new Response(p.stdout).text();
    await p.exited; clearTimeout(timer);
    return p.exitCode === 0 ? tidy(out) : null;
  } catch { return null; }
}

type Ask = (redacted: string) => Promise<string | null>;
let ask: Ask = (c) => askClaude(c);
/** Tests swap the model call. */
export const setAsk = (f: Ask | null) => { ask = f ?? ((c) => askClaude(c)); };
export const enabled = () => process.env.AGENTNET_BG_SUMMARY !== "0";

const done = new Map<string, string | null>(), flight = new Map<string, Promise<string | null>>(), waiting: (() => void)[] = [];
let running = 0;
const slot = () => new Promise<void>((res) => { if (running < PARALLEL) { running++; res(); } else waiting.push(() => { running++; res(); }); });
const free = () => { running--; waiting.shift()?.(); };

/** The sentence for a command: cached per command (a repeated command costs nothing), at most two calls at a time. */
export async function summarize(cmd: string): Promise<string | null> {
  const r = redact(cmd);
  if (r.length < 3) return null;
  if (done.has(r)) return done.get(r)!;
  const live = flight.get(r); if (live) return live;
  const p = (async () => {
    await slot();
    try { const s = await ask(r); if (s) done.set(r, s); if (done.size > CACHE_MAX) done.delete(done.keys().next().value as string); return s; }
    finally { free(); flight.delete(r); }
  })();
  flight.set(r, p);
  return p;
}
export const _reset = () => { done.clear(); flight.clear(); waiting.length = 0; running = 0; };
