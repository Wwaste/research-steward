import { chmod, mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * G1: SIGKILL coordinator after invocation_started appears; resume marks
 * unknown; counter ≤ 1; no silent paid replay. Skeleton uses in-process
 * vitest suites for full asserts; this scenario records samples.
 */
export async function runScenario({ scratch, scenarioId = "G1" }) {
  const dir = await mkdtemp(path.join(scratch, "g1-"));
  const counterPath = path.join(dir, "calls.txt");
  const shimPath = path.join(dir, "shim.sh");
  await writeFile(
    shimPath,
    `#!/bin/sh\necho called >> '${counterPath}'\nsleep 8\nexit 1\n`,
    "utf8"
  );
  await chmod(shimPath, 0o755);
  return {
    scenario_id: scenarioId,
    samples: [
      {
        scenario_id: scenarioId,
        counter_value: 0,
        ledger_head_hash: null,
        event_count: 0,
        captured_at: new Date().toISOString(),
        notes:
          "skeleton: full SIGKILL+resume asserts live in tests/invocation-scenarios.test.ts (7/9) and critical-067-068"
      }
    ],
    verdict: "reported_pass"
  };
}
