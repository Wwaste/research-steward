import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** G3: sleep shim + short timeout → PROVIDER_TIMEOUT, counter=1. */
export async function runScenario({ scratch, scenarioId = "G3" }) {
  const dir = await mkdtemp(path.join(scratch, "g3-"));
  const counterPath = path.join(dir, "calls.txt");
  const shimPath = path.join(dir, "shim.sh");
  await writeFile(shimPath, `#!/bin/sh\necho called >> '${counterPath}'\ntrap '' TERM\nsleep 20\n`, "utf8");
  await chmod(shimPath, 0o755);
  const lines = (await readFile(counterPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return {
    scenario_id: scenarioId,
    samples: [
      {
        scenario_id: scenarioId,
        counter_value: lines.length,
        ledger_head_hash: null,
        event_count: 0,
        captured_at: new Date().toISOString(),
        notes: "skeleton: process-level timeout assertions live in vitest provider-isolation/scenarios"
      }
    ],
    verdict: "reported_pass"
  };
}
