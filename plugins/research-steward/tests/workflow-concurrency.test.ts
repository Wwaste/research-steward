import { mkdir, rename, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoundtableNode, RoundtablePlan } from "../src/protocol.js";

vi.mock("../src/providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers.js")>();
  return {
    ...actual,
    runProvider: vi.fn(async (node: RoundtableNode) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return {
        output: {
          status: "complete" as const,
          summary: `Completed ${node.id}`,
          uncertainties: [],
          evidence: [],
          findings: [],
          decisions: []
        },
        adapter: node.adapter,
        model: node.model ?? "lease-test-double",
        duration_ms: 250,
        exit_code: 0,
        stdout_hash: "a".repeat(64),
        stdout_chars: 10,
        stderr_hash: "b".repeat(64),
        stderr_chars: 0,
        executable_name: "lease-test-double"
      };
    })
  };
});

import { runProvider } from "../src/providers.js";
import { appendEvent, freezePacket } from "../src/store.js";
import { runRoundtable } from "../src/workflow.js";
import { sha256Text, stableJson } from "../src/utils.js";
import { eventsForRun, expectErrorCode, initializedProject } from "./helpers.js";

function plan(packetId: string, wallTime = 30_000): RoundtablePlan {
  return {
    version: 1,
    name: "Run lease contract",
    packet_id: packetId,
    mode: "open",
    limits: {
      max_parallel: 1,
      max_wall_time_ms: wallTime,
      max_prompt_chars: 20_000,
      max_output_chars: 10_000,
      retry_limit: 0,
      max_failures: 0
    },
    nodes: [
      {
        id: "reviewer",
        actor_id: "reviewer",
        role: "reviewer",
        adapter: "fake",
        brief: "Review once.",
        depends_on: [],
        visibility: "shared",
        can_adjudicate: false,
        timeout_ms: 5_000
      }
    ]
  };
}

async function projectWithPacket(): Promise<string> {
  const root = await initializedProject("Workflow lease test");
  await writeFile(path.join(root, "evidence.md"), "evidence\n", "utf8");
  await freezePacket(root, "lease-input", ["evidence.md"]);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("roundtable run lease and persisted deadline", () => {
  it("prevents a second coordinator from invoking the same run node", async () => {
    const root = await projectWithPacket();
    const input = plan("lease-input");
    const first = runRoundtable(root, input, "same-run");

    while (vi.mocked(runProvider).mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expectErrorCode(runRoundtable(root, input, "same-run"), "RUN_ACTIVE");
    await expect(first).resolves.toMatchObject({ outcome: "complete" });

    expect(runProvider).toHaveBeenCalledTimes(1);
    const nodeEvents = (await eventsForRun(root, "same-run")).filter(
      (event) => event.metadata["node_id"] === "reviewer"
    );
    expect(nodeEvents).toHaveLength(1);
  });

  it("P1-5 lets only one coordinator atomically reclaim a stale run lease", async () => {
    const root = await projectWithPacket();
    const input = plan("lease-input");
    const lease = path.join(root, ".research", "runs", "stale-run", ".lease");
    await mkdir(lease, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(lease, "owner.json"),
      `${JSON.stringify({
        owner_token: "00000000-0000-4000-8000-000000000001",
        pid: 1,
        acquired_at: "2000-01-01T00:00:00.000Z"
      })}\n`,
      "utf8"
    );
    const stale = new Date(Date.now() - 60_000);
    await utimes(lease, stale, stale);

    const coordinatorCount = 16;
    const outcomes = await Promise.allSettled(
      Array.from({ length: coordinatorCount }, () =>
        runRoundtable(root, input, "stale-run")
      )
    );
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(coordinatorCount - 1);
    for (const outcome of rejected) {
      expect(outcome.reason).toMatchObject({ code: "RUN_ACTIVE" });
    }
    expect(runProvider).toHaveBeenCalledTimes(1);
  });

  it("refuses to commit a node after coordinator lease ownership is replaced", async () => {
    const root = await projectWithPacket();
    const input = plan("lease-input");
    const run = runRoundtable(root, input, "stolen-run");

    while (vi.mocked(runProvider).mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const runDirectory = path.join(root, ".research", "runs", "stolen-run");
    const lease = path.join(runDirectory, ".lease");
    await rename(lease, path.join(runDirectory, ".lease-stolen-by-test"));
    await mkdir(lease, { mode: 0o700 });
    await writeFile(
      path.join(lease, "owner.json"),
      `${JSON.stringify({
        owner_token: "00000000-0000-4000-8000-000000000003",
        pid: 2,
        acquired_at: new Date().toISOString()
      })}\n`,
      "utf8"
    );

    await expectErrorCode(run, "LOCK_LOST");
    const nodeEvents = (await eventsForRun(root, "stolen-run")).filter(
      (event) => event.metadata["node_id"] === "reviewer"
    );
    expect(nodeEvents).toHaveLength(0);
  });

  it("does not reset max_wall_time when an old run is resumed", async () => {
    const root = await projectWithPacket();
    const input = plan("lease-input", 1_000);
    const planHash = sha256Text(stableJson(input));
    const packet = await import("../src/store.js").then(({ loadPacket }) =>
      loadPacket(root, "lease-input")
    );
    await appendEvent(root, {
      type: "run_started",
      run_id: "expired-run",
      actor: { id: "research-steward", role: "coordinator" },
      input_hash: packet.packet_hash,
      summary: "Persisted run start for deadline test.",
      metadata: {
        plan_hash: planHash,
        mode: input.mode,
        packet_id: input.packet_id,
        max_wall_time_ms: input.limits.max_wall_time_ms
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const result = await runRoundtable(root, input, "expired-run");

    expect(result).toMatchObject({ outcome: "failed", blocked_nodes: ["reviewer"] });
    expect(runProvider).not.toHaveBeenCalled();
    expect(
      (await eventsForRun(root, "expired-run")).find(
        (event) => event.metadata["node_id"] === "reviewer"
      )
    ).toMatchObject({ status: "blocked", metadata: { blocked_by: "wall-time" } });
  });
});
