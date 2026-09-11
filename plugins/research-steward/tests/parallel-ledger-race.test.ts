import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __test_getReadsInsideNodeScope,
  __test_resetReadsInsideNodeScope,
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

function twoNodePlan(adapter: "fake" | "kimi", extraLimits: Record<string, unknown> = {}) {
  return {
    version: 1,
    name: "inv",
    packet_id: "pkt-inv",
    mode: "open",
    limits: {
      max_parallel: 2,
      max_wall_time_ms: 1_800_000,
      max_prompt_chars: 20_000,
      max_output_chars: 10_000,
      retry_limit: 0,
      max_failures: 3,
      ...extraLimits
    },
    nodes: [
      {
        id: "a",
        actor_id: "aa",
        role: "analyst",
        adapter,
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
        adapter,
        brief: "b",
        depends_on: [],
        visibility: "shared",
        can_adjudicate: false,
        timeout_ms: 8_000
      }
    ]
  } as never;
}

/**
 * CR-M-078-v3 main defense: readEvents must never run inside runOneNode.
 * Any restore of the CR-M-075 defect (any adapter, any position) is
 * deterministic red via the node-scope counter.
 */
describe("CR-M-078-v3 readEvents node-scope invariant", () => {
  it(
    "zero readEvents calls inside runOneNode for parallel fake nodes",
    async () => {
      process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER = "1";
      const root = await initializedProject("inv-fake");
      await writeFile(path.join(root, "n.md"), "x\n", "utf8");
      await freezePacket(root, "pkt-inv", ["n.md"]);
      __test_resetReadsInsideNodeScope();
      try {
        const result = await runRoundtable(root, twoNodePlan("fake"), "inv-fake");
        expect(result.outcome).toBe("complete");
        expect(__test_getReadsInsideNodeScope()).toBe(0);
      } finally {
        delete process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER;
      }
    },
    20_000
  );

  it(
    "zero readEvents calls inside runOneNode for parallel paid nodes (budget path)",
    async () => {
      const shimDir = await mkdtemp(path.join(os.tmpdir(), "rs-inv-"));
      const shimPath = path.join(shimDir, "ok.sh");
      await writeFile(shimPath, "#!/bin/sh\nsleep 0.15\necho ok\n", "utf8");
      await chmod(shimPath, 0o755);
      const root = await initializedProject("inv-paid");
      await writeFile(path.join(root, "n.md"), "x\n", "utf8");
      await freezePacket(root, "pkt-inv", ["n.md"]);
      const prev = process.env.RESEARCH_STEWARD_KIMI_PATH;
      process.env.RESEARCH_STEWARD_KIMI_PATH = shimPath;
      __test_resetReadsInsideNodeScope();
      try {
        // Outcome may be failed if the shim is not a real kimi CLI; the
        // invariant only requires that the budget/permit path ran without
        // a mid-batch public readEvents.
        await runRoundtable(root, twoNodePlan("kimi"), "inv-paid");
        expect(__test_getReadsInsideNodeScope()).toBe(0);
      } finally {
        if (prev === undefined) delete process.env.RESEARCH_STEWARD_KIMI_PATH;
        else process.env.RESEARCH_STEWARD_KIMI_PATH = prev;
        await rm(shimDir, { recursive: true, force: true });
      }
    },
    25_000
  );
});

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
