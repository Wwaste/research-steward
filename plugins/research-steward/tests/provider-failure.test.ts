import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RoundtablePlan } from "../src/protocol.js";
import { freezePacket } from "../src/store.js";
import { runRoundtable } from "../src/workflow.js";
import { eventsForRun, initializedProject } from "./helpers.js";

const originalQoderPath = process.env["RESEARCH_STEWARD_QODER_PATH"];

afterEach(() => {
  if (originalQoderPath === undefined) {
    delete process.env["RESEARCH_STEWARD_QODER_PATH"];
  } else {
    process.env["RESEARCH_STEWARD_QODER_PATH"] = originalQoderPath;
  }
});

function limits(): RoundtablePlan["limits"] {
  return {
    max_parallel: 1,
    max_wall_time_ms: 30_000,
    max_prompt_chars: 20_000,
    max_output_chars: 10_000,
    retry_limit: 0,
    max_failures: 0
  };
}

describe("provider failure durability", () => {
  it("records hashed diagnostics, blocks the remaining DAG, and writes a terminal result", async () => {
    const root = await initializedProject("Invalid provider output");
    await writeFile(path.join(root, "evidence.md"), "# Frozen evidence\n", "utf8");
    await freezePacket(root, "failure-input", ["evidence.md"]);

    const executable = path.join(root, "invalid-provider.mjs");
    const invalidStdout = "not-json-sensitive-provider-output";
    const invalidStderr = "sensitive-provider-diagnostic";
    await writeFile(
      executable,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(invalidStdout)});\nprocess.stderr.write(${JSON.stringify(invalidStderr)});\n`,
      { mode: 0o700 }
    );
    await chmod(executable, 0o700);
    process.env["RESEARCH_STEWARD_QODER_PATH"] = executable;

    const plan: RoundtablePlan = {
      version: 1,
      name: "fail-loud provider run",
      packet_id: "failure-input",
      mode: "blind",
      limits: limits(),
      nodes: [
        {
          id: "reviewer-a",
          actor_id: "reviewer-a",
          role: "independent reviewer",
          adapter: "qoder",
          brief: "Review the frozen evidence.",
          depends_on: [],
          visibility: "blind",
          blind_group: "peer-review",
          can_adjudicate: false,
          timeout_ms: 5_000
        },
        {
          id: "reviewer-b",
          actor_id: "reviewer-b",
          role: "independent reviewer",
          adapter: "qoder",
          brief: "Review the frozen evidence independently.",
          depends_on: [],
          visibility: "blind",
          blind_group: "peer-review",
          can_adjudicate: false,
          timeout_ms: 5_000
        },
        {
          id: "adjudicator",
          actor_id: "adjudicator",
          role: "evidence adjudicator",
          adapter: "qoder",
          brief: "Adjudicate both frozen reviews.",
          depends_on: ["reviewer-a", "reviewer-b"],
          visibility: "shared",
          can_adjudicate: true,
          timeout_ms: 5_000
        }
      ]
    };

    const result = await runRoundtable(root, plan, "provider-failure");
    const events = await eventsForRun(root, result.run_id);
    const failed = events.find((event) => event.metadata["node_id"] === "reviewer-a");
    const blockedReviewer = events.find((event) => event.metadata["node_id"] === "reviewer-b");
    const blockedAdjudicator = events.find((event) => event.metadata["node_id"] === "adjudicator");
    const barrier = events.find((event) => event.type === "review_barrier_closed");

    expect(result).toMatchObject({
      outcome: "failed",
      failed_nodes: ["reviewer-a"],
      blocked_nodes: ["reviewer-b", "adjudicator"]
    });
    expect(failed).toMatchObject({
      status: "failed",
      metadata: {
        error_code: "MODEL_OUTPUT_REJECTED",
        stdout_chars: invalidStdout.length,
        stderr_chars: invalidStderr.length,
        parser_error_code: "INVALID_MODEL_JSON"
      }
    });
    expect(failed?.metadata["stdout_hash"]).toMatch(/^[a-f0-9]{64}$/);
    expect(failed?.metadata["stderr_hash"]).toMatch(/^[a-f0-9]{64}$/);
    expect(blockedReviewer).toMatchObject({ status: "blocked", metadata: { blocked_by: "failure-budget" } });
    expect(blockedAdjudicator).toMatchObject({ status: "blocked", metadata: { blocked_by: "failure-budget" } });
    expect(barrier).toMatchObject({ status: "blocked" });

    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain(invalidStdout);
    expect(serializedEvents).not.toContain(invalidStderr);
    const resultFile = JSON.parse(
      await readFile(path.join(root, ".research", "runs", result.run_id, "result.json"), "utf8")
    ) as unknown;
    expect(resultFile).toEqual(result);
  });
});
