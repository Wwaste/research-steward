import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ResearchStewardError } from "../src/utils.js";

const calls = vi.hoisted(() => ({
  count: 0,
  mode: "quota" as "quota" | "transport" | "auth" | "model_not_found" | "cancelled" | "timeout"
}));

vi.mock("../src/providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers.js")>();
  return {
    ...actual,
    runProvider: async (...args: unknown[]) => {
      calls.count += 1;
      if (calls.mode !== "transport") {
        throw new ResearchStewardError("PROVIDER_EXIT_FAILED", calls.mode, {
          failure_class: calls.mode,
          stderr_hash: "a".repeat(64)
        });
      }
      throw new ResearchStewardError("PROVIDER_SPAWN_FAILED", "transport", {
        failure_class: "transport"
      });
    }
  };
});

import { runRoundtable } from "../src/workflow.js";
import { freezePacket } from "../src/store.js";
import { initializedProject } from "./helpers.js";

function planFixture(retryLimit: number) {
  return {
    version: 1,
    name: "retry wiring",
    packet_id: "pkt-retry",
    mode: "open" as const,
    limits: {
      max_parallel: 1,
      max_wall_time_ms: 1_800_000,
      max_prompt_chars: 20_000,
      max_output_chars: 10_000,
      retry_limit: retryLimit,
      max_failures: 3
    },
    nodes: [
      {
        id: "n1",
        actor_id: "a1",
        role: "analyst",
        adapter: "kimi" as const,
        model: "kimi-latest",
        brief: "b",
        depends_on: [] as string[],
        visibility: "shared" as const,
        can_adjudicate: false,
        timeout_ms: 30_000
      }
    ]
  };
}

describe("non-retryable classes (CR-M-048)", () => {
  for (const mode of ["auth", "model_not_found", "cancelled", "timeout"] as const) {
    it(`does not retry ${mode}`, async () => {
      calls.count = 0;
      calls.mode = mode;
      const root = await initializedProject(mode);
      await writeFilePkt(root);
      await runRoundtable(root, planFixture(2) as never, `no-retry-${mode}`);
      expect(calls.count).toBe(1);
    });
  }
});

describe("retry policy wiring (RS-V1-SUP-018)", () => {
  it("does not retry quota failures even when retry_limit is 2", async () => {
    calls.count = 0;
    calls.mode = "quota";
    const root = await initializedProject("Quota no retry");
    await writeFilePkt(root);
    await runRoundtable(root, planFixture(2) as never, "quota-no-retry");
    expect(calls.count).toBe(1);
  });

  it("retries transport failures within the policy bound", async () => {
    calls.count = 0;
    calls.mode = "transport";
    const root = await initializedProject("Transport retry");
    await writeFilePkt(root);
    await runRoundtable(root, planFixture(2) as never, "transport-retry");
    // attempt 1 + 2 transport retries = 3
    expect(calls.count).toBe(3);
  });
});

async function writeFilePkt(root: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(root, "notes.md"), "x\n", "utf8");
  await freezePacket(root, "pkt-retry", ["notes.md"]);
}
