import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RoundtablePlan } from "../src/protocol.js";
import { freezePacket } from "../src/store.js";
import { runRoundtable } from "../src/workflow.js";
import { eventsForRun, expectErrorCode, initializedProject } from "./helpers.js";

const originalFakeSetting = process.env["RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER"];

beforeAll(() => {
  process.env["RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER"] = "1";
});

afterAll(() => {
  if (originalFakeSetting === undefined) {
    delete process.env["RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER"];
  } else {
    process.env["RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER"] = originalFakeSetting;
  }
});

function limits(): RoundtablePlan["limits"] {
  return {
    max_parallel: 2,
    max_wall_time_ms: 30_000,
    max_prompt_chars: 20_000,
    max_output_chars: 10_000,
    retry_limit: 0,
    max_failures: 0
  };
}

describe("round-table DAG", () => {
  it("runs the checked-in deterministic walkthrough with visible deferred findings", async () => {
    const root = await initializedProject("Deterministic walkthrough");
    await writeFile(path.join(root, "evidence.md"), "# Walkthrough evidence\n", "utf8");
    await freezePacket(root, "protocol-v1", ["evidence.md"]);
    const plan = JSON.parse(
      await readFile(path.join(process.cwd(), "examples/fake-roundtable.plan.json"), "utf8")
    ) as unknown;

    const result = await runRoundtable(root, plan, "walkthrough-plan");
    const events = await eventsForRun(root, result.run_id);
    const adjudication = events.find(
      (event) => event.metadata["node_id"] === "adjudicator"
    );
    expect(result.outcome).toBe("complete");
    expect(adjudication).toMatchObject({
      type: "adjudication",
      status: "complete",
      findings: [],
      decisions: [
        expect.objectContaining({ disposition: "defer" }),
        expect.objectContaining({ disposition: "defer" }),
        expect.objectContaining({ disposition: "defer" })
      ]
    });
  });

  it("enforces plan mode instead of silently treating a mislabeled run as open or blind", async () => {
    const root = await initializedProject("Mode preflight");
    const sharedNode = {
      id: "shared-reviewer",
      actor_id: "shared-reviewer",
      role: "reviewer",
      adapter: "fake" as const,
      brief: "Review openly.",
      depends_on: [],
      visibility: "shared" as const,
      timeout_ms: 5_000
    };
    await expectErrorCode(
      runRoundtable(
        root,
        {
          version: 1,
          name: "mislabeled blind",
          packet_id: "not-needed-for-preflight",
          mode: "blind",
          limits: limits(),
          nodes: [sharedNode]
        },
        "mislabeled-blind"
      ),
      "BLIND_MODE_WITHOUT_BLIND_REVIEW"
    );
    await expectErrorCode(
      runRoundtable(
        root,
        {
          version: 1,
          name: "mislabeled open",
          packet_id: "not-needed-for-preflight",
          mode: "open",
          limits: limits(),
          nodes: [
            {
              ...sharedNode,
              id: "blind-a",
              actor_id: "blind-a",
              visibility: "blind",
              blind_group: "peers"
            },
            {
              ...sharedNode,
              id: "blind-b",
              actor_id: "blind-b",
              visibility: "blind",
              blind_group: "peers"
            }
          ]
        },
        "mislabeled-open"
      ),
      "OPEN_MODE_HAS_BLIND_NODE"
    );
  });

  it("automatically runs B only after A is committed and gives B an explicit dependency", async () => {
    const root = await initializedProject("A then B");
    await writeFile(path.join(root, "evidence.md"), "# Frozen evidence\n\nObserved result.\n", "utf8");
    await freezePacket(root, "dag-input", ["evidence.md"]);
    const plan: RoundtablePlan = {
      version: 1,
      name: "producer then reviewer",
      packet_id: "dag-input",
      mode: "open",
      limits: limits(),
      nodes: [
        {
          id: "producer",
          actor_id: "agent-a",
          role: "producer",
          adapter: "fake",
          brief: "Draft the evidence-bounded result.",
          depends_on: [],
          visibility: "shared",
          can_adjudicate: false,
          timeout_ms: 5_000
        },
        {
          id: "reviewer",
          actor_id: "agent-b",
          role: "reviewer",
          adapter: "fake",
          brief: "Review the producer output.",
          depends_on: ["producer"],
          visibility: "shared",
          can_adjudicate: false,
          timeout_ms: 5_000
        }
      ]
    };

    const result = await runRoundtable(root, plan, "dag-a-to-b");
    const events = await eventsForRun(root, result.run_id);
    const a = events.find((event) => event.metadata["node_id"] === "producer");
    const b = events.find((event) => event.metadata["node_id"] === "reviewer");

    expect(result.completed_nodes).toEqual(["producer", "reviewer"]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.sequence).toBeLessThan(b!.sequence);
    expect(b!.depends_on).toEqual([a!.event_id]);
    expect(a!.input_hash).toBe(b!.input_hash);
    expect(b!.actor).toMatchObject({ id: "agent-b", adapter: "fake" });
  });

  it("rejects dependencies between peers in the same blind group before any model runs", async () => {
    const root = await initializedProject("Blind peers");
    const invalidPlan = {
      version: 1,
      name: "invalid blind dependency",
      packet_id: "not-needed-for-preflight",
      mode: "blind",
      limits: limits(),
      nodes: [
        {
          id: "blind-a",
          actor_id: "reviewer-a",
          role: "independent reviewer",
          adapter: "fake",
          brief: "Review independently.",
          depends_on: [],
          visibility: "blind",
          blind_group: "peer-review",
          timeout_ms: 5_000
        },
        {
          id: "blind-b",
          actor_id: "reviewer-b",
          role: "independent reviewer",
          adapter: "fake",
          brief: "Review independently.",
          depends_on: ["blind-a"],
          visibility: "blind",
          blind_group: "peer-review",
          timeout_ms: 5_000
        }
      ]
    };

    await expectErrorCode(runRoundtable(root, invalidPlan, "blind-invalid"), "BLINDNESS_VIOLATION");
    expect(await eventsForRun(root, "blind-invalid")).toEqual([]);
  });

  it("rejects a consumer that depends on only part of a blind review group", async () => {
    const root = await initializedProject("Partial blind group");
    const invalidPlan = {
      version: 1,
      name: "partial blind group dependency",
      packet_id: "not-needed-for-preflight",
      mode: "mixed",
      limits: limits(),
      nodes: [
        {
          id: "blind-a",
          actor_id: "reviewer-a",
          role: "independent reviewer",
          adapter: "fake",
          brief: "Review independently.",
          depends_on: [],
          visibility: "blind",
          blind_group: "peer-review",
          timeout_ms: 5_000
        },
        {
          id: "blind-b",
          actor_id: "reviewer-b",
          role: "independent reviewer",
          adapter: "fake",
          brief: "Review independently.",
          depends_on: [],
          visibility: "blind",
          blind_group: "peer-review",
          timeout_ms: 5_000
        },
        {
          id: "consumer",
          actor_id: "consumer",
          role: "consumer",
          adapter: "fake",
          brief: "Consume the review group.",
          depends_on: ["blind-a"],
          visibility: "shared",
          timeout_ms: 5_000
        }
      ]
    };

    await expectErrorCode(
      runRoundtable(root, invalidPlan, "partial-blind-group"),
      "PARTIAL_BLIND_GROUP_DEPENDENCY"
    );
    expect(await eventsForRun(root, "partial-blind-group")).toEqual([]);
  });

  it("refuses to label a Kimi lane blind when its CLI cannot prove tool denial", async () => {
    const root = await initializedProject("Unsafe blind adapter");
    const nodes = ["a", "b"].map((suffix) => ({
      id: `kimi-${suffix}`,
      actor_id: `kimi-${suffix}`,
      role: "independent reviewer",
      adapter: "kimi" as const,
      brief: "Review independently.",
      depends_on: [],
      visibility: "blind" as const,
      blind_group: "kimi-peers",
      timeout_ms: 5_000
    }));

    await expectErrorCode(
      runRoundtable(
        root,
        {
          version: 1,
          name: "unsafe Kimi blind lane",
          packet_id: "not-needed-for-preflight",
          mode: "blind",
          limits: limits(),
          nodes
        },
        "unsafe-kimi-blind"
      ),
      "BLIND_ADAPTER_UNSAFE"
    );
    expect(await eventsForRun(root, "unsafe-kimi-blind")).toEqual([]);
  });
});
