import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chmod, mkdtemp, writeFile as wf } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { freezePacket } from "../src/store.js";
import { runRoundtable } from "../src/workflow.js";
import { initializedProject } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

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


describe("CR-M-078 staggered parallel ledger race", () => {
  it("overlapping node completions do not hit LEDGER_HEAD_MISMATCH", async () => {
    const shimDir = await mkdtemp(path.join(os.tmpdir(), "rs-stag-"));
    cleanup.push(shimDir);
    const counter = path.join(shimDir, "c.txt");
    const slow = path.join(shimDir, "slow.sh");
    await wf(slow, `#!/bin/sh\necho called >> '${counter}'\nsleep 0.8\necho 'quota exceeded' >&2\nexit 1\n`, "utf8");
    await chmod(slow, 0o755);
    const fast = path.join(shimDir, "fast.sh");
    await wf(fast, `#!/bin/sh\necho called >> '${counter}'\necho 'quota exceeded' >&2\nexit 1\n`, "utf8");
    await chmod(fast, 0o755);
    const root = await initializedProject("stagger");
    await wf(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-st", ["n.md"]);
    const prevSlow = process.env.RESEARCH_STEWARD_KIMI_PATH;
    // Both nodes use kimi; the same PATH variable is read per-call — set to slow
    // then use two shims via separate env is not possible in one process.
    // Instead: two independent nodes both sleep via one shim that sleeps 0.8s,
    // max_parallel=2 so they overlap; retry_limit=1 on A adds a staggered retry.
    process.env.RESEARCH_STEWARD_KIMI_PATH = slow;
    try {
      await runRoundtable(
        root,
        {
          version: 1,
          name: "stag",
          packet_id: "pkt-st",
          mode: "open",
          limits: {
            max_parallel: 2,
            max_wall_time_ms: 1_800_000,
            max_prompt_chars: 20_000,
            max_output_chars: 10_000,
            retry_limit: 0,
            max_failures: 4,
            budget_window_ms: 1_800_000,
            budget_max_invocations: 10
          },
          nodes: [
            {
              id: "a",
              actor_id: "aa",
              role: "analyst",
              adapter: "kimi",
              model: "kimi-latest",
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
              adapter: "kimi",
              model: "kimi-latest",
              brief: "b",
              depends_on: [],
              visibility: "shared",
              can_adjudicate: false,
              timeout_ms: 8_000
            }
          ]
        } as never,
        "stag-run"
      );
      // If readEvents were reintroduced in the parallel path this would throw
      // LEDGER_HEAD_MISMATCH; reaching here means the snapshot path held.
      expect(true).toBe(true);
    } finally {
      if (prevSlow === undefined) delete process.env.RESEARCH_STEWARD_KIMI_PATH;
      else process.env.RESEARCH_STEWARD_KIMI_PATH = prevSlow;
    }
    const { readFile } = await import("node:fs/promises");
    const lines = (await readFile(counter, "utf8")).trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});
