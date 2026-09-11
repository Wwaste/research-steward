#!/usr/bin/env node
/**
 * Phase 2 gate orchestrator (DESIGN-PHASE2-GATE).
 * Black-box: real driver processes + shims; evidence only from ledger,
 * counter files, and exit codes. No production test hooks.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS = ["g1-crash", "g3-timeout", "g4-quota", "g8-v01-readonly"];

async function main() {
  const scratch = path.join(here, "..", "..", ".gate-scratch");
  await mkdir(scratch, { recursive: true });
  const results = [];
  for (const id of SCENARIOS) {
    const mod = await import(path.join(here, "scenarios", `${id}.mjs`));
    const result = await mod.runScenario({ scratch, scenarioId: id });
    results.push(result);
  }
  const failed = results.filter((r) => r.verdict !== "reported_pass");
  await writeFile(
    path.join(scratch, "phase2-gate.json"),
    JSON.stringify(
      {
        report_version: 1,
        generated_at: new Date().toISOString(),
        status: failed.length === 0 ? "reported_pass" : "failed",
        scenarios: results
      },
      null,
      2
    )
  );
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exit(1);
});
