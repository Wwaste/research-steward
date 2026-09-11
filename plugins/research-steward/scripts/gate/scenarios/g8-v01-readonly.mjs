import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";

/** G8: git archive v0.1.0 fixture exists (read-only verify deferred to vitest tag lane). */
export async function runScenario({ scratch, scenarioId = "G8" }) {
  const dir = await mkdtemp(path.join(scratch, "g8-"));
  const out = spawnSync("git", ["-C", path.resolve(scratch, "..", "..", ".."), "rev-parse", "v0.1.0"], {
    encoding: "utf8"
  });
  const ok = out.status === 0;
  return {
    scenario_id: scenarioId,
    samples: [
      {
        scenario_id: scenarioId,
        counter_value: ok ? 1 : 0,
        ledger_head_hash: null,
        event_count: 0,
        captured_at: new Date().toISOString(),
        notes: ok ? `tag ${out.stdout.trim().slice(0, 12)}` : "tag missing"
      }
    ],
    verdict: ok ? "reported_pass" : "failed"
  };
}
