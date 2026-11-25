// Writes the three seeded verifier tasks (frozen mini pages with a known truth) into the bank. Usage: bun scripts/evals/seed-verifier.ts [--home DIR]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
const i = process.argv.indexOf("--home");
const HOME = i > 0 ? process.argv[i + 1]! : process.env.AGENTNET_HOME ?? join(homedir(), ".local", "share", "agentnet");
const seeds = resolve(import.meta.dir, "seeds", "verifier");
const ask = (crit: string[]) => `Verify the static page index.html in the current folder against these acceptance criteria. It is a plain file: read it, no browser, no server. Do not edit anything. Write a verdict table with the measured value next to each criterion, then one line "VERDICT PASS" or "VERDICT FAIL".\nCriteria:\n${crit.map((c, n) => `${n + 1}. ${c}`).join("\n")}`;
const T = [
  { id: "verifier-seed-sum", crit: ["The Total equals the sum of the item prices.", "The item count label equals the number of table rows.", "Every price shows a currency."], verdict: "FAIL", must: "total|55|sum" },
  { id: "verifier-seed-clean", crit: ["The Total equals the sum of the item prices.", "The item count label equals the number of table rows.", "Every price shows a currency."], verdict: "PASS", must: "" },
  { id: "verifier-seed-order", crit: ["The log is sorted newest first.", "The count label equals the number of list items.", "'Last deploy' names the newest entry."], verdict: "FAIL", must: "order|sort|2026-11-22|v4" },
];
for (const t of T) {
  const dir = join(HOME, "evals", "bank", "verifier"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${t.id}.json`), JSON.stringify({ id: t.id, brain: "verifier", kind: "efficiency", status: "ready", why: ["seeded"], source: { seeded: true }, seed: join(seeds, t.id.replace("verifier-seed-", "")), repo: "", ref: "", prompt: ask(t.crit),
    checks: [{ type: "verdict", verdict: t.verdict, must: t.must }], budget_usd: 2, max_turns: 30 }, null, 2) + "\n");
}
console.log(`wrote ${T.length} seeded tasks`);
