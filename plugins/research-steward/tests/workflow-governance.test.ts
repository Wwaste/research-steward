import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RoundtableNode, RoundtablePlan } from "../src/protocol.js";

vi.mock("../src/providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers.js")>();
  return {
    ...actual,
    runProvider: vi.fn(async (node: RoundtableNode) => ({
      output: {
        status: node.id === "blocked-adjudicator" ? ("blocked" as const) : ("complete" as const),
        summary: `Governance test response for ${node.id}`,
        uncertainties: ["Synthetic provider output for authorization testing."],
        evidence: [
          {
            locator: "frozen:test-input",
            kind: "artifact" as const,
            note: "Synthetic frozen evidence locator."
          }
        ],
        findings: [
          {
            id: "provider-finding",
            severity: "medium" as const,
            claim: "The provider reports a finding.",
            evidence: [],
            uncertainty: "Synthetic test finding.",
            remediation: "Require explicit adjudication."
          }
        ],
        // Deliberately return a decision for every role. The workflow, not the
        // model's compliance with its prompt, must enforce adjudication rights.
        decisions: [
          {
            finding_id:
              node.id === "inventing-adjudicator"
                ? "invented-finding"
                : "reviewer.provider-finding",
            disposition: "accept" as const,
            rationale: `Proposed by ${node.actor_id}`,
            action: "Record only when authorized.",
            owner: "research-steward",
            change_evidence: "A stronger frozen counterexample."
          }
        ]
      },
      adapter: node.adapter,
      model: node.model ?? "governance-test-double",
      duration_ms: 0,
      exit_code: 0,
      stdout_hash: "a".repeat(64),
      stdout_chars: 100,
      stderr_hash: "b".repeat(64),
      stderr_chars: 0,
      executable_name: "governance-test-double"
    }))
  };
});

import { freezePacket } from "../src/store.js";
import { runProvider } from "../src/providers.js";
import { runRoundtable } from "../src/workflow.js";
import { eventsForRun, expectErrorCode, initializedProject, readUtf8 } from "./helpers.js";

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

async function projectWithPacket(): Promise<string> {
  const root = await initializedProject("Governed round table");
  await writeFile(path.join(root, "evidence.md"), "# Frozen evidence\n", "utf8");
  await freezePacket(root, "governance-input", ["evidence.md"]);
  return root;
}

function reviewerNode(): RoundtableNode {
  return {
    id: "reviewer",
    actor_id: "reviewer-a",
    role: "reviewer",
    adapter: "fake",
    brief: "Report findings without adjudicating them.",
    depends_on: [],
    visibility: "shared",
    can_adjudicate: false,
    timeout_ms: 5_000
  };
}

describe("round-table adjudication authority", () => {
  it("strips provider decisions from an ordinary reviewer event and both decision views", async () => {
    const root = await projectWithPacket();
    const plan: RoundtablePlan = {
      version: 1,
      name: "unauthorized decision filtering",
      packet_id: "governance-input",
      mode: "open",
      limits: limits(),
      nodes: [reviewerNode()]
    };

    await runRoundtable(root, plan, "reviewer-cannot-adjudicate");
    const event = (await eventsForRun(root, "reviewer-cannot-adjudicate")).find(
      (candidate) => candidate.metadata["node_id"] === "reviewer"
    );

    expect(event).toMatchObject({
      type: "agent_contribution",
      decisions: [],
      metadata: {
        can_adjudicate: false,
        ignored_unauthorized_decisions: 1
      }
    });
    expect(event?.findings).toHaveLength(1);
    expect(event?.findings[0]?.id).toBe("reviewer.provider-finding");
    expect(await readUtf8(root, "DECISIONS.md")).not.toContain("provider-finding");
    expect(await readUtf8(root, ".research/rendered/DECISIONS.md")).not.toContain(
      "provider-finding"
    );
  });

  it("commits an authorized dependent node as an adjudication event", async () => {
    const root = await projectWithPacket();
    const adjudicator: RoundtableNode = {
      id: "adjudicator",
      actor_id: "adjudicator-a",
      role: "evidence adjudicator",
      adapter: "fake",
      brief: "Adjudicate the committed reviewer finding.",
      depends_on: ["reviewer"],
      visibility: "shared",
      can_adjudicate: true,
      timeout_ms: 5_000
    };
    const plan: RoundtablePlan = {
      version: 1,
      name: "authorized adjudication",
      packet_id: "governance-input",
      mode: "open",
      limits: limits(),
      nodes: [reviewerNode(), adjudicator]
    };

    const result = await runRoundtable(root, plan, "authorized-adjudication");
    const events = await eventsForRun(root, result.run_id);
    const review = events.find((event) => event.metadata["node_id"] === "reviewer");
    const adjudication = events.find((event) => event.metadata["node_id"] === "adjudicator");

    expect(result.completed_nodes).toEqual(["reviewer", "adjudicator"]);
    expect(adjudication).toMatchObject({
      type: "adjudication",
      actor: { id: "adjudicator-a" },
      metadata: {
        can_adjudicate: true,
        ignored_unauthorized_decisions: 0
      }
    });
    expect(adjudication?.depends_on).toEqual([review?.event_id]);
    expect(adjudication?.decisions).toEqual([
      expect.objectContaining({
        finding_id: "reviewer.provider-finding",
        disposition: "accept",
        rationale: "Proposed by adjudicator-a"
      })
    ]);
    expect(await readUtf8(root, "DECISIONS.md")).toContain(
      "provider-finding: accept"
    );
    expect(await readUtf8(root, ".research/rendered/DECISIONS.md")).toContain(
      "provider-finding: accept"
    );
    const adjudicatorCall = vi.mocked(runProvider).mock.calls.find(
      ([node]) => node.id === "adjudicator"
    );
    expect(adjudicatorCall).toBeDefined();
    const adjudicatorPrompt = adjudicatorCall?.[1] ?? "";
    expect(adjudicatorPrompt).toContain('"findings"');
    expect(adjudicatorPrompt).toContain("reviewer.provider-finding");
    expect(adjudicatorPrompt.indexOf("reviewer.provider-finding")).toBeLessThan(
      adjudicatorPrompt.indexOf("=== FROZEN INPUT ===")
    );
  });

  it("rejects an adjudicator with no committed dependency during graph preflight", async () => {
    const root = await initializedProject("Invalid adjudicator");
    const invalidPlan = {
      version: 1,
      name: "adjudicator without input",
      packet_id: "preflight-only",
      mode: "open",
      limits: limits(),
      nodes: [
        {
          ...reviewerNode(),
          id: "orphan-adjudicator",
          actor_id: "adjudicator-a",
          role: "evidence adjudicator",
          can_adjudicate: true
        }
      ]
    };

    await expectErrorCode(
      runRoundtable(root, invalidPlan, "orphan-adjudicator"),
      "ADJUDICATOR_WITHOUT_INPUT"
    );
    expect(await eventsForRun(root, "orphan-adjudicator")).toEqual([]);
  });

  it("does not turn a blocked adjudicator's proposed decisions into authority", async () => {
    const root = await projectWithPacket();
    const plan: RoundtablePlan = {
      version: 1,
      name: "blocked adjudicator",
      packet_id: "governance-input",
      mode: "open",
      limits: limits(),
      nodes: [
        reviewerNode(),
        {
          id: "blocked-adjudicator",
          actor_id: "blocked-adjudicator",
          role: "evidence adjudicator",
          adapter: "fake",
          brief: "Block rather than claim a disposition when evidence is insufficient.",
          depends_on: ["reviewer"],
          visibility: "shared",
          can_adjudicate: true,
          timeout_ms: 5_000
        }
      ]
    };

    const result = await runRoundtable(root, plan, "blocked-adjudicator-run");
    const event = (await eventsForRun(root, result.run_id)).find(
      (candidate) => candidate.metadata["node_id"] === "blocked-adjudicator"
    );
    expect(event).toMatchObject({
      type: "agent_contribution",
      status: "blocked",
      decisions: [],
      metadata: { ignored_unauthorized_decisions: 1 }
    });
    expect(await readUtf8(root, "DECISIONS.md")).not.toContain("reviewer.provider-finding: accept");
  });

  it("fails closed when an adjudicator invents a finding ID", async () => {
    const root = await projectWithPacket();
    const plan: RoundtablePlan = {
      version: 1,
      name: "invented adjudication",
      packet_id: "governance-input",
      mode: "open",
      limits: { ...limits(), retry_limit: 2 },
      nodes: [
        reviewerNode(),
        {
          id: "inventing-adjudicator",
          actor_id: "inventing-adjudicator",
          role: "evidence adjudicator",
          adapter: "fake",
          brief: "Adjudicate only findings that actually exist.",
          depends_on: ["reviewer"],
          visibility: "shared",
          can_adjudicate: true,
          timeout_ms: 5_000
        }
      ]
    };

    const result = await runRoundtable(root, plan, "invented-adjudication-run");
    const event = (await eventsForRun(root, result.run_id)).find(
      (candidate) => candidate.metadata["node_id"] === "inventing-adjudicator"
    );
    expect(result.outcome).toBe("failed");
    expect(event).toMatchObject({
      type: "agent_contribution",
      status: "failed",
      decisions: [],
      metadata: { error_code: "ADJUDICATION_COVERAGE_MISMATCH" }
    });
    expect(await readUtf8(root, "DECISIONS.md")).not.toContain("invented-finding");
    expect(
      vi.mocked(runProvider).mock.calls.filter(
        ([calledNode]) => calledNode.id === "inventing-adjudicator"
      )
    ).toHaveLength(1);
  });
});
