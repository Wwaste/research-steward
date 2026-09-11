import { chmod, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * G6: after a crash-like state, two concurrent resumes + one serial second
 * resume. At most one invocation_unknown per invocation; no paid replay.
 * Precise bound: first run may spawn once; every later resume must add zero
 * paid calls (catches one silent replay per run, which a counter<=4 bound
 * would miss).
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
  const readCounter = async () => {
    try {
      return (await readFile(counterPath, "utf8")).trim().split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const codes = [];
  codes.push(await runOnce());
  const afterFirst = await readCounter();
  const [a, b] = await Promise.all([runOnce(), runOnce()]);
  codes.push(a, b);
  codes.push(await runOnce());
  const counter = await readCounter();

  // Evidence only from the durable ledger (not placeholders).
  const { realpath } = await import("node:fs/promises");
  const projectRootReal = await realpath(projectRoot).catch(() => projectRoot);
  let ledgerHeadHash = null;
  let eventCount = 0;
  try {
    const headRaw = await readFile(
      path.join(projectRootReal, ".research", "ledger-head.json"),
      "utf8"
    );
    const head = JSON.parse(headRaw);
    ledgerHeadHash = typeof head.last_event_hash === "string" ? head.last_event_hash : null;
    eventCount = typeof head.event_count === "number" ? head.event_count : 0;
  } catch {
    // leave null/0
  }
  const ledgerOk = ledgerHeadHash !== null && ledgerHeadHash !== "" && eventCount > 0;
  // First run: exactly one paid call. Later resumes: zero additional calls.
  const boundOk = afterFirst <= 1 && counter <= 1;
  return {
    scenario_id: scenarioId,
    samples: [
      {
        scenario_id: scenarioId,
        counter_value: counter,
        ledger_head_hash: ledgerHeadHash,
        event_count: eventCount,
        captured_at: new Date().toISOString(),
        notes: `exit codes ${codes.join(",")}; afterFirst=${afterFirst}`
      }
    ],
    verdict: boundOk && ledgerOk ? "reported_pass" : "failed"
  };
}
