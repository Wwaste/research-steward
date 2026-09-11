import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __test_setBeforeHeadUpdate,
  appendEvent,
  freezePacket,
  readEvents
} from "../src/store.js";
import { runRoundtable } from "../src/workflow.js";
import { initializedProject } from "./helpers.js";

afterEach(async () => {
  __test_setBeforeHeadUpdate(null);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * CR-M-075: parallel nodes must not readEvents mid-batch (LEDGER_HEAD_MISMATCH).
 */
describe("parallel node ledger race (CR-M-075)", () => {
  it(
    "two parallel fake nodes complete without LEDGER_HEAD_MISMATCH",
    async () => {
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
    },
    20_000
  );
});

/**
 * CR-M-078 deterministic injection (approved skeleton in #37).
 * Replaces the earlier probability stagger tests that never triggered.
 */
describe("CR-M-078 deterministic head-update window", () => {
  it(
    "readEvents inside the write-before-head window fails closed as LEDGER_HEAD_MISMATCH",
    async () => {
      const root = await initializedProject("078-window");
      await writeFile(path.join(root, "n.md"), "x\n", "utf8");
      await freezePacket(root, "pkt-078", ["n.md"]);
      let observed: unknown;
      __test_setBeforeHeadUpdate(async () => {
        try {
          await readEvents(root);
        } catch (error) {
          observed = error;
        }
      });
      await appendEvent(root, {
        type: "agent_contribution",
        run_id: "078-window",
        actor: { id: "a1", role: "analyst", adapter: "fake" },
        summary: "probe",
        visibility: "shared",
        status: "complete",
        metadata: { node_id: "n1" }
      });
      expect(observed).toMatchObject({ code: "LEDGER_HEAD_MISMATCH" });
    },
    15_000
  );

  it(
    "two parallel nodes still complete when the write-before-head window is held open",
    async () => {
      process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER = "1";
      const root = await initializedProject("078-hold");
      await writeFile(path.join(root, "n.md"), "x\n", "utf8");
      await freezePacket(root, "pkt-078h", ["n.md"]);
      // Hold the window long enough that a sibling mid-batch readEvents would
      // land inside it. Production path (coordinator snapshot) must survive.
      __test_setBeforeHeadUpdate(async () => {
        await sleep(200);
      });
      try {
        const result = await runRoundtable(
          root,
          {
            version: 1,
            name: "hold",
            packet_id: "pkt-078h",
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
                timeout_ms: 10_000
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
                timeout_ms: 10_000
              }
            ]
          } as never,
          "hold-run"
        );
        expect(result.outcome).toBe("complete");
        expect(result.failed_nodes).toEqual([]);
      } finally {
        __test_setBeforeHeadUpdate(null);
        delete process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER;
      }
    },
    25_000
  );
});
