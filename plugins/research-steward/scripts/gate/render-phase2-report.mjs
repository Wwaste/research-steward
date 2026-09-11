#!/usr/bin/env node
/**
 * Render PHASE-2.md from gate results. Status is always reported_pass|failed
 * from the implementation side — the authoritative gate verdict is external.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, "..", "..", ".gate-scratch");
const resultsPath = path.join(scratch, "phase2-gate.json");
const outPath = path.join(scratch, "PHASE-2.md");

const raw = JSON.parse(await readFile(resultsPath, "utf8"));
const lines = [
  "# PHASE-2 report (implementation-side)",
  "",
  `Generated: ${raw.generated_at}`,
  `Implementation status: **${raw.status}** (not an authoritative gate verdict)`,
  "",
  "## Scenarios",
  "",
  "| ID | verdict | counter | notes |",
  "|---|---|---|---|"
];
for (const s of raw.scenarios ?? []) {
  const sample = s.samples?.[0] ?? {};
  lines.push(
    `| ${s.scenario_id} | ${s.verdict} | ${sample.counter_value ?? "-"} | ${sample.notes ?? ""} |`
  );
}
lines.push(
  "",
  "## Open items (honest)",
  "- G2 CLI cancel path still unwired in dist",
  "- G7 full 10k/100k relative budgets pending (SUP-015)",
  "- Authoritative gate verdict requires external review + user approval",
  ""
);
await writeFile(outPath, lines.join("\n"));
process.stdout.write(`${outPath}\n`);
