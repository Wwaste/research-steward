import { chmod, mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * G1: SIGKILL the driver after invocation_started appears in the ledger.
 * Then resume the same run: workflow must mark the started invocation
 * unknown (no silent paid replay). Counter must not grow; ledger evidence
 * is read from the durable head (no placeholders).
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

  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const projectRoot = path.join(dir, "project");
  await mkdir(projectRoot, { recursive: true });

  const driver = path.join(pluginRoot, "scripts", "gate", "driver-run.mjs");
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
          // Kill only after the durable head has caught up to the event
          // files (append committed, not inside write-before-head).
          try {
            const headRaw = await readFile(
              path.join(projectRootReal, ".research", "ledger-head.json"),
              "utf8"
            );
            const head = JSON.parse(headRaw);
            const eventFiles = files.filter((f) => f.endsWith(".json")).length;
            if (
              typeof head.last_event_hash === "string" &&
              head.last_event_hash.length === 64 &&
              head.event_count === eventFiles &&
              contents.some((c) => c.includes("invocation_started"))
            ) {
              child.kill("SIGKILL");
              killed = true;
              break;
            }
          } catch {
            // keep polling
          }
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

  // G1 resume step: compress the production LOCK_STALE_MS (120s) wait by
  // backdating crash-left locks, then run the same project/run again.
  // Resume must mark the started invocation unknown and not grow paid calls.
  await backdateStaleLocks(projectRootReal);
  const counterBeforeResume = await readCounter(counterPath);
  let resumeCode = -1;
  let marked = false;
  let resumeErr = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await backdateStaleLocks(projectRootReal);
    resumeCode = await new Promise((resolve) => {
      const resume = spawn(
        process.execPath,
        [driver, projectRoot, "pkt-g1", "g1-run", shimPath],
        {
          stdio: ["ignore", "ignore", "pipe"],
          env: { ...process.env, RESEARCH_STEWARD_KIMI_PATH: shimPath }
        }
      );
      let err = "";
      resume.stderr?.on("data", (d) => {
        err += String(d);
      });
      resume.on("exit", (code) => {
        if (code !== 0) {
          const lines = err.split("\n").filter((l) => /ResearchStewardError:|code:/.test(l));
          resumeErr = lines.slice(0, 4).join(" | ");
        }
        resolve(code ?? -1);
      });
    });
    try {
      const files = await readdir(eventsDir);
      const contents = await Promise.all(
        files.map(async (f) => {
          try {
            return await readFile(path.join(eventsDir, f), "utf8");
          } catch {
            return "";
          }
        })
      );
      marked = contents.some((c) => c.includes("invocation_unknown"));
    } catch {
      marked = false;
    }
    if (marked) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const counterAfterResume = await readCounter(counterPath);

  let unknownMarked = false;
  try {
    const files = await readdir(eventsDir);
    const contents = await Promise.all(
      files.map(async (f) => {
        try {
          return await readFile(path.join(eventsDir, f), "utf8");
        } catch {
          return "";
        }
      })
    );
    unknownMarked = contents.some((c) => c.includes("invocation_unknown"));
  } catch {
    unknownMarked = false;
  }

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

  return {
    scenario_id: scenarioId,
    samples: [
      {
        scenario_id: scenarioId,
        counter_value: counterAfterResume,
        ledger_head_hash: ledgerHeadHash,
        event_count: eventCount,
        window_class: "W2",
        captured_at: new Date().toISOString(),
        notes: killed
          ? `killed after invocation_started; resume unknown=${unknownMarked}; resumeCode=${resumeCode}; counter ${counterBeforeResume}→${counterAfterResume}${resumeErr ? `; err=${resumeErr.replace(/\s+/g, " ").slice(0, 120)}` : ""}`
          : "window not sampled"
      }
    ],
    verdict:
      killed &&
      unknownMarked &&
      counterAfterResume <= 1 &&
      counterAfterResume === counterBeforeResume &&
      ledgerOk
        ? "reported_pass"
        : "failed"
  };
}

async function readCounter(counterPath) {
  try {
    return (await readFile(counterPath, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * After SIGKILL, directory leases remain until LOCK_STALE_MS / run-lease
 * stale. The gate compresses that wait by renaming crash-left leases aside
 * (same shape as production reclaim) so resume can proceed immediately.
 */
async function backdateStaleLocks(projectRootReal) {
  const { rename, readdir, utimes } = await import("node:fs/promises");
  const research = path.join(projectRootReal, ".research");
  const old = new Date(Date.now() - 30 * 60_000);
  const leases = [];
  const visit = async (dir, depth) => {
    if (depth > 5) return;
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(dir, n);
      if (n === ".lease" || n.startsWith(".event-lock") || n.startsWith(".render-lock") || n.startsWith(".packet-")) {
        leases.push(p);
      }
      if (n === "runs" || dir.endsWith(path.sep + "runs") || n === ".lease" || n.startsWith(".event-lock") || n.startsWith(".render-lock")) {
        await visit(p, depth + 1);
      }
    }
  };
  await visit(research, 0);
  for (const p of leases) {
    const retired = `${p}.gate-retired-${Date.now()}`;
    try {
      await rename(p, retired);
    } catch {
      try {
        await utimes(p, old, old);
      } catch {
        // ignore
      }
    }
  }
}
