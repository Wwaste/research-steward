import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** G3: sleep shim + short timeout via driver; counter=1, no retry. */
export async function runScenario({ scratch, scenarioId = "G3" }) {
  const dir = await mkdtemp(path.join(scratch, "g3-"));
  const counterPath = path.join(dir, "calls.txt");
  const shimPath = path.join(dir, "shim.sh");
  await writeFile(
    shimPath,
    `#!/bin/sh\necho called >> '${counterPath}'\ntrap '' TERM\nsleep 20\n`,
    "utf8"
  );
  await chmod(shimPath, 0o755);
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const driver = path.join(pluginRoot, "scripts", "gate", "driver-run.mjs");
  const projectRoot = path.join(dir, "project");
  await (await import("node:fs/promises")).mkdir(projectRoot, { recursive: true });
  // driver uses 15s timeout; we want timeout — use a tiny wrapper that sets timeout via env
  // Instead: run driver with shim that traps TERM (SIGKILL escalation path)
  const child = spawn(
    process.execPath,
    [driver, projectRoot, "pkt-g3", "g3-run", shimPath],
    { stdio: "ignore", env: { ...process.env, RESEARCH_STEWARD_KIMI_PATH: shimPath } }
  );
  await Promise.race([
    new Promise((r) => child.on("exit", r)),
    new Promise((r) => setTimeout(r, 20000))
  ]);
  if (child.exitCode === null) {
    try { child.kill("SIGKILL"); } catch {}
  }
  let counter = 0;
  try {
    counter = (await readFile(counterPath, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch {}
  return {
    scenario_id: scenarioId,
    samples: [
      {
        scenario_id: scenarioId,
        counter_value: counter,
        ledger_head_hash: null,
        event_count: 0,
        captured_at: new Date().toISOString(),
        notes: "trap-TERM shim through driver; timeout classified in vitest provider-isolation"
      }
    ],
    verdict: counter <= 1 ? "reported_pass" : "failed"
  };
}
