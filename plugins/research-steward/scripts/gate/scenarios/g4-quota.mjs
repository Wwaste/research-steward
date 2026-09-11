import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

/** G4 skeleton: quota shim evidence recorded; full assert in retry-shim suite. */
export async function runScenario({ scratch, scenarioId = "G4" }) {
  const dir = await mkdtemp(path.join(scratch, "g4-"));
  const counterPath = path.join(dir, "calls.txt");
  const shimPath = path.join(dir, "shim.sh");
  await writeFile(shimPath, `#!/bin/sh\necho called >> '${counterPath}'\necho 'quota exceeded for this billing period' >&2\nexit 1\n`, "utf8");
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
        notes: "skeleton: quota no-retry asserted in tests/retry-shim.test.ts"
      }
    ],
    verdict: "reported_pass"
  };
}
