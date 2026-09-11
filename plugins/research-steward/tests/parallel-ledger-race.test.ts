import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freezePacket } from "../src/store.js";
import { runRoundtable } from "../src/workflow.js";
import { initializedProject } from "./helpers.js";

/**
 * CR-M-075: parallel nodes must not readEvents mid-batch (LEDGER_HEAD_MISMATCH).
 */
describe("parallel node ledger race (CR-M-075)", () => {
  it("two parallel fake nodes complete without LEDGER_HEAD_MISMATCH", async () => {
    process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER = "1";
    const root = await initializedProject("parallel-race");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-par", ["n.md"]);
    try {
      const result = await runRoundtable(
        root,
        {
          version: 1,
          name: "par",
          packet_id: "pkt-par",
          mode: "open",
          limits: {
            max_parallel: 2,
            max_wall_time_ms: 1_800_000,
            max_prompt_chars: 20_000,
            max_output_chars: 10_000,
            retry_limit: 0,
            max_failures: 3
          },
          nodes: [
            {
              id: "a",
              actor_id: "aa",
              role: "analyst",
              adapter: "fake",
              brief: "a",
              depends_on: [],
              visibility: "shared",
              can_adjudicate: false,
              timeout_ms: 8_000
            },
            {
              id: "b",
              actor_id: "ab",
              role: "analyst",
              adapter: "fake",
              brief: "b",
              depends_on: [],
              visibility: "shared",
              can_adjudicate: false,
              timeout_ms: 8_000
            }
          ]
        } as never,
        "par-run"
      );
      expect(result.outcome).toBe("complete");
      expect(result.failed_nodes).toEqual([]);
    } finally {
      delete process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER;
    }
  });
});
