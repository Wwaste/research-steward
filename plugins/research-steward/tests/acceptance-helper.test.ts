import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { prepareAcceptance } from "../src/acceptance-helper.js";
import type { VerificationReport } from "../src/protocol.js";
import {
  appendEvent,
  freezePacket,
  recordAcceptance,
  recordProvisionalReview,
  verifyProject
} from "../src/store.js";
import { expectErrorCode, initializedProject, readUtf8 } from "./helpers.js";

interface ParsedAcceptance {
  human_approvals: Array<{
    id?: string;
    required?: boolean;
    status?: string;
    authority?: string;
    accepts?: { verification_event_id?: string; verification_event_hash?: string };
    note?: string;
  }>;
}

async function verifiedProject(
  title = "Acceptance helper test"
): Promise<{ root: string; report: VerificationReport }> {
  const root = await initializedProject(title);
  await writeFile(path.join(root, "analysis.md"), "candidate result\n", "utf8");
  await freezePacket(root, "candidate", ["analysis.md"]);
  const report = await verifyProject(root);
  expect(report.passed).toBe(true);
  return { root, report };
}

function withoutAcceptsLines(text: string): string {
  return text
    .split("\n")
    .filter(
      (line) =>
        !line.includes("verification_event_id") && !line.includes("verification_event_hash")
    )
    .join("\n");
}

describe("prepareAcceptance", () => {
  it("fills only the accepts block of the unique required approval and keeps every other byte", async () => {
    const { root, report } = await verifiedProject();
    const before = await readUtf8(root, "ACCEPTANCE.yaml");

    const result = await prepareAcceptance(root, {});

    expect(result).toEqual({
      approval_id: "scientific-acceptance",
      verification_event_id: report.verification_event_id,
      verification_event_hash: report.verification_event_hash,
      changed: true
    });
    const after = await readUtf8(root, "ACCEPTANCE.yaml");
    expect(withoutAcceptsLines(after)).toBe(withoutAcceptsLines(before));
    const parsed = parseYaml(after) as ParsedAcceptance;
    const approval = parsed.human_approvals[0]!;
    expect(approval.accepts).toEqual({
      verification_event_id: report.verification_event_id,
      verification_event_hash: report.verification_event_hash
    });
    expect(approval.status).toBe("pending");
    expect(approval.authority).toBe("");
    expect(approval.note).toBe("Deterministic checks do not establish scientific correctness.");
  });

  it("returns changed: false and leaves the file untouched when the target already matches", async () => {
    const { root } = await verifiedProject();
    const first = await prepareAcceptance(root, {});
    expect(first.changed).toBe(true);
    const afterFirst = await readUtf8(root, "ACCEPTANCE.yaml");

    const second = await prepareAcceptance(root, {});

    expect(second).toEqual({ ...first, changed: false });
    expect(await readUtf8(root, "ACCEPTANCE.yaml")).toBe(afterFirst);
  });

  it("rejects with VERIFICATION_NOT_CURRENT when a later event supersedes the verification", async () => {
    const { root } = await verifiedProject();
    await appendEvent(root, {
      type: "agent_contribution",
      actor: { id: "late-agent", role: "analyst" },
      summary: "Additional work after the verification event."
    });

    await expectErrorCode(prepareAcceptance(root, {}), "VERIFICATION_NOT_CURRENT");
  });

  it("still treats the verification as current after a provisional review, like recordAcceptance", async () => {
    const { root, report } = await verifiedProject();
    await recordProvisionalReview(
      root,
      "night-agent",
      report.verification_event_id,
      "Provisional overnight review."
    );

    const result = await prepareAcceptance(root, {});

    expect(result.verification_event_id).toBe(report.verification_event_id);
    expect(result.changed).toBe(true);
  });

  it("rejects with UNRESOLVED_BLOCKER while any blocker is unresolved", async () => {
    const { root } = await verifiedProject();
    await appendEvent(root, {
      type: "blocked",
      status: "blocked",
      actor: { id: "reviewer-a", role: "reviewer" },
      summary: "Blocking question about the analysis."
    });

    await expectErrorCode(prepareAcceptance(root, {}), "UNRESOLVED_BLOCKER");
  });

  it("rejects with VERIFICATION_REQUIRED when no passing verification exists", async () => {
    const root = await initializedProject("No verification yet");

    await expectErrorCode(prepareAcceptance(root, {}), "VERIFICATION_REQUIRED");
  });

  it("never promotes a provisional review into acceptance: status stays pending and recordAcceptance still refuses", async () => {
    const { root, report } = await verifiedProject();
    await recordProvisionalReview(
      root,
      "night-agent",
      report.verification_event_id,
      "Provisional overnight review."
    );
    await prepareAcceptance(root, {});

    const text = await readUtf8(root, "ACCEPTANCE.yaml");
    expect(text).toContain("status: pending");
    await expectErrorCode(
      recordAcceptance(root, "test-authority", "Attempted without human approval."),
      "HUMAN_APPROVAL_PENDING"
    );
  });

  it("never writes authority on the user's behalf: with empty authority recordAcceptance still refuses", async () => {
    const { root } = await verifiedProject();
    await writeFile(
      path.join(root, "ACCEPTANCE.yaml"),
      `version: 1
commands: []
human_approvals:
  - id: scientific-acceptance
    required: true
    status: approved
    authority: ""
    accepts:
      verification_event_id: ""
      verification_event_hash: ""
    note: "Status flipped by hand, authority intentionally left empty."
`,
      "utf8"
    );

    const result = await prepareAcceptance(root, {});

    expect(result.changed).toBe(true);
    const parsed = parseYaml(await readUtf8(root, "ACCEPTANCE.yaml")) as ParsedAcceptance;
    expect(parsed.human_approvals[0]!.authority).toBe("");
    await expectErrorCode(
      recordAcceptance(root, "test-authority", "Attempted without a named authority."),
      "HUMAN_APPROVAL_PENDING"
    );
  });

  it("requires an explicit approvalId when several approvals are required, then fills only that one", async () => {
    const { root, report } = await verifiedProject();
    await writeFile(
      path.join(root, "ACCEPTANCE.yaml"),
      `version: 1
commands: []
human_approvals:
  - id: lead
    required: true
    status: pending
    authority: ""
    accepts:
      verification_event_id: ""
      verification_event_hash: ""
  - id: reviewer
    required: true
    status: pending
    authority: ""
    accepts:
      verification_event_id: ""
      verification_event_hash: ""
`,
      "utf8"
    );

    await expectErrorCode(prepareAcceptance(root, {}), "APPROVAL_ID_REQUIRED");
    await expectErrorCode(
      prepareAcceptance(root, { approvalId: "nobody" }),
      "APPROVAL_NOT_FOUND"
    );

    const result = await prepareAcceptance(root, { approvalId: "reviewer" });

    expect(result.approval_id).toBe("reviewer");
    const parsed = parseYaml(await readUtf8(root, "ACCEPTANCE.yaml")) as ParsedAcceptance;
    const lead = parsed.human_approvals.find((approval) => approval.id === "lead")!;
    const reviewer = parsed.human_approvals.find((approval) => approval.id === "reviewer")!;
    expect(lead.accepts).toEqual({ verification_event_id: "", verification_event_hash: "" });
    expect(reviewer.accepts).toEqual({
      verification_event_id: report.verification_event_id,
      verification_event_hash: report.verification_event_hash
    });
  });

  it("rejects a malformed acceptance document", async () => {
    const { root } = await verifiedProject();
    await writeFile(path.join(root, "ACCEPTANCE.yaml"), "version: 2\n", "utf8");

    await expectErrorCode(prepareAcceptance(root, {}), "INVALID_ACCEPTANCE_DOCUMENT");
  });

  it("fills accepts so that a fully human-approved document passes recordAcceptance", async () => {
    const { root, report } = await verifiedProject();
    await prepareAcceptance(root, {});
    const filled = await readFile(path.join(root, "ACCEPTANCE.yaml"), "utf8");
    await writeFile(
      path.join(root, "ACCEPTANCE.yaml"),
      filled
        .replace("status: pending", "status: approved")
        .replace('authority: ""', "authority: test-authority"),
      "utf8"
    );

    const acceptance = await recordAcceptance(
      root,
      "test-authority",
      "Human authority confirmed the helper-prepared target."
    );

    expect(acceptance).toMatchObject({
      type: "acceptance",
      status: "complete",
      metadata: expect.objectContaining({
        verification_event_id: report.verification_event_id
      })
    });
  });
});

describe("prepareAcceptance preconditions (fix round 1)", () => {
  it("rejects with FROZEN_PACKET_REQUIRED when no packet was frozen before the verification", async () => {
    const root = await initializedProject("No frozen packet");
    const report = await verifyProject(root);
    expect(report.passed).toBe(true);

    await expectErrorCode(prepareAcceptance(root, {}), "FROZEN_PACKET_REQUIRED");
  });

  it("rejects a file that is not parseable YAML with INVALID_ACCEPTANCE_DOCUMENT", async () => {
    const { root } = await verifiedProject();
    await writeFile(path.join(root, "ACCEPTANCE.yaml"), "foo: [unclosed\n", "utf8");

    await expectErrorCode(prepareAcceptance(root, {}), "INVALID_ACCEPTANCE_DOCUMENT");
  });

  it("rejects an explicit approvalId that matches several approvals with INVALID_ACCEPTANCE_DOCUMENT", async () => {
    const { root } = await verifiedProject();
    await writeFile(
      path.join(root, "ACCEPTANCE.yaml"),
      `version: 1
commands: []
human_approvals:
  - id: scientific-acceptance
    required: true
    status: pending
    authority: ""
    accepts:
      verification_event_id: ""
      verification_event_hash: ""
  - id: scientific-acceptance
    required: true
    status: pending
    authority: ""
    accepts:
      verification_event_id: ""
      verification_event_hash: ""
`,
      "utf8"
    );

    await expectErrorCode(
      prepareAcceptance(root, { approvalId: "scientific-acceptance" }),
      "INVALID_ACCEPTANCE_DOCUMENT"
    );
  });
});
