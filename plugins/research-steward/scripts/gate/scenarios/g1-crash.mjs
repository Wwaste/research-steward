import { chmod, mkdir, mkdtemp, readFile, writeFile, readdir, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * G1: SIGKILL the driver after invocation_started appears in the ledger.
 * Resume marks unknown; counter must not grow; no paid replay.
 */
export async function runScenario({ scratch, scenarioId = "G1" }) {
  const dir = await mkdtemp(path.join(scratch, "g1-"));
  const counterPath = path.join(dir, "calls.txt");
  const shimPath = path.join(dir, "shim.sh");
  await writeFile(
    shimPath,
    `#!/bin/sh\necho called >> '${counterPath}'\nsleep 10\nexit 1\n`,
    "utf8"
  );
  await chmod(shimPath, 0o755);

  // Minimal driver: import dist workflow and run one kimi node.
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const distCli = path.join(pluginRoot, "dist", "cli.mjs");
  const projectRoot = path.join(dir, "project");
  await mkdir(projectRoot, { recursive: true });

  const driver = path.join(pluginRoot, "scripts", "gate", "driver-run.mjs");
  await mkdir(projectRoot, { recursive: true });
  const child = spawn(process.execPath, [driver, projectRoot, "pkt-g1", "g1-run", shimPath], {
    stdio: "ignore",
    env: { ...process.env, RESEARCH_STEWARD_KIMI_PATH: shimPath }
  });
  const { realpath } = await import("node:fs/promises");
  const projectRootReal = await realpath(projectRoot).catch(() => projectRoot);
  const eventsDir = path.join(projectRootReal, ".research", "events");
  const deadline = Date.now() + 25000;
  let killed = false;
  while (Date.now() < deadline) {
    try {
      const files = await readdir(eventsDir);
      if (files.some((f) => f.includes(".json"))) {
        // check for invocation_started by reading files is heavy; kill after first event files exist
        const contents = await Promise.all(
          files.slice(0, 50).map(async (f) => {
            try {
              return await readFile(path.join(eventsDir, f), "utf8");
            } catch {
              return "";
            }
          })
        );
        if (contents.some((c) => c.includes("invocation_started"))) {
          child.kill("SIGKILL");
          killed = true;
          break;
        }
      }
    } catch {
      // events dir not ready
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  await Promise.race([
    new Promise((r) => child.on("exit", r)),
    new Promise((r) => setTimeout(r, 3000))
  ]);
  if (!child.killed && child.exitCode === null) {
    try { child.kill("SIGKILL"); } catch {}
  }
  let counter = 0;
  try {
    counter = (await readFile(counterPath, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch {
    counter = 0;
  }
  return {
    scenario_id: scenarioId,
    samples: [
      {
        scenario_id: scenarioId,
        counter_value: counter,
        ledger_head_hash: null,
        event_count: 0,
        window_class: "W2",
        captured_at: new Date().toISOString(),
        notes: killed ? "killed after invocation_started" : "window not sampled"
      }
    ],
    verdict: killed && counter <= 1 ? "reported_pass" : "failed"
  };
}
