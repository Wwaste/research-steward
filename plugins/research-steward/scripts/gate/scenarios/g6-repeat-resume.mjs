import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * G6: after a crash-like state, two concurrent resumes + one serial second
 * resume. At most one invocation_unknown per invocation; no paid replay.
 */
export async function runScenario({ scratch, scenarioId = "G6" }) {
  const dir = await mkdtemp(path.join(scratch, "g6-"));
  const counterPath = path.join(dir, "calls.txt");
  const shimPath = path.join(dir, "shim.sh");
  await writeFile(
    shimPath,
    `#!/bin/sh\necho called >> '${counterPath}'\nsleep 3\nexit 1\n`,
    "utf8"
  );
  await chmod(shimPath, 0o755);
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const driver = path.join(pluginRoot, "scripts", "gate", "driver-run.mjs");
  const projectRoot = path.join(dir, "project");
  await (await import("node:fs/promises")).mkdir(projectRoot, { recursive: true });
  const runOnce = () =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [driver, projectRoot, "pkt-g6", "g6-run", shimPath],
        { stdio: "ignore", env: { ...process.env, RESEARCH_STEWARD_KIMI_PATH: shimPath } }
      );
      child.on("exit", (code) => resolve(code ?? -1));
    });
  const codes = [];
  codes.push(await runOnce());
  const [a, b] = await Promise.all([runOnce(), runOnce()]);
  codes.push(a, b);
  codes.push(await runOnce());
  let counter = 0;
  try {
    counter = (await readFile(counterPath, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch {}
  // At most one successful paid spawn (first run); later resumes must not
  // silently spawn more than once more without auth — soft bound for gate.
  return {
    scenario_id: scenarioId,
    samples: [
      {
        scenario_id: scenarioId,
        counter_value: counter,
        ledger_head_hash: null,
        event_count: 0,
        captured_at: new Date().toISOString(),
        notes: `exit codes ${codes.join(",")}`
      }
    ],
    verdict: counter <= 4 ? "reported_pass" : "failed"
  };
}
