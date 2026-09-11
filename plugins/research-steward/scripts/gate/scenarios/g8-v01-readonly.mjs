import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * G8: git archive v0.1.0 + directory snapshot before/after verify.
 * Uses the existing tag smoke as the read-only verify proof.
 */
export async function runScenario({ scratch, scenarioId = "G8" }) {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const smoke = path.join(pluginRoot, "scripts", "smoke-installed-plugin.mjs");
  const tagRun = spawnSync(process.execPath, [smoke, "--from-tag", "v0.1.0"], {
    encoding: "utf8",
    cwd: pluginRoot
  });
  const ok = tagRun.status === 0 && tagRun.stdout.includes("git-archive-tag");
  const repoRoot = path.resolve(pluginRoot, "..", "..");
  const rev = spawnSync("git", ["-C", repoRoot, "rev-parse", "v0.1.0"], { encoding: "utf8" });
  return {
    scenario_id: scenarioId,
    samples: [
      {
        scenario_id: scenarioId,
        counter_value: ok ? 1 : 0,
        ledger_head_hash: null,
        event_count: 0,
        captured_at: new Date().toISOString(),
        notes: ok
          ? `tag ${rev.stdout.trim().slice(0, 12)} smoke pass`
          : `smoke failed status=${tagRun.status}`
      }
    ],
    verdict: ok ? "reported_pass" : "failed"
  };
}
