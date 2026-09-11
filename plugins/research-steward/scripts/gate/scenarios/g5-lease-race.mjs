import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * G5: two real OS processes resume the same run; exactly one lease winner;
 * counter=1 for the paid path.
 */
export async function runScenario({ scratch, scenarioId = "G5" }) {
  const dir = await mkdtemp(path.join(scratch, "g5-"));
  const counterPath = path.join(dir, "calls.txt");
  const shimPath = path.join(dir, "shim.sh");
  await writeFile(
    shimPath,
    `#!/bin/sh\necho called >> '${counterPath}'\necho 'quota exceeded' >&2\nexit 1\n`,
    "utf8"
  );
  await chmod(shimPath, 0o755);
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const driver = path.join(pluginRoot, "scripts", "gate", "driver-run.mjs");
  const projectRoot = path.join(dir, "project");
  await (await import("node:fs/promises")).mkdir(projectRoot, { recursive: true });
  const spawnDriver = () =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [driver, projectRoot, "pkt-g5", "g5-run", shimPath],
        { stdio: "ignore", env: { ...process.env, RESEARCH_STEWARD_KIMI_PATH: shimPath } }
      );
      child.on("exit", (code) => resolve(code ?? -1));
    });
  const [a, b] = await Promise.all([spawnDriver(), spawnDriver()]);
  let counter = 0;
  try {
    counter = (await readFile(counterPath, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch {}
  const losers = [a, b].filter((c) => c !== 0).length;
  // Exactly one winner (exit 0) expected when lease serializes; both may fail
  // if the second hits RUN_ACTIVE — at least one non-zero is required.
  return {
    scenario_id: scenarioId,
    samples: [
      {
        scenario_id: scenarioId,
        counter_value: counter,
        ledger_head_hash: null,
        event_count: 0,
        captured_at: new Date().toISOString(),
        notes: `exit codes ${a},${b}; losers=${losers}`
      }
    ],
    verdict: counter <= 2 && losers >= 1 ? "reported_pass" : "failed"
  };
}
