import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendEvent,
  freezePacket,
  projectSummary,
  readEvents,
  recordAcceptance,
  recordProvisionalReview,
  resolveBlocks,
  verifyProject
} from "../src/store.js";
import { packageHandoff } from "../src/package.js";
import { expectErrorCode, initializedProject } from "./helpers.js";

describe("deterministic verification boundary", () => {
  it("can pass deterministic checks while leaving scientific acceptance explicitly pending", async () => {
    const root = await initializedProject("Scientific boundary");

    const report = await verifyProject(root);
    const acceptance = await readFile(path.join(root, "ACCEPTANCE.yaml"), "utf8");
    const verification = (await readEvents(root)).at(-1);

    expect(report.passed).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "acceptance:syntax", status: "pass" })
    );
    expect(acceptance).toContain("status: pending");
    expect(verification).toMatchObject({
      type: "verification",
      status: "complete",
      metadata: { passed: true }
    });
    expect(verification?.uncertainties.join(" ")).toMatch(/does not establish scientific correctness/i);
    expect((await readFile(path.join(root, "STATUS.md"), "utf8"))).toContain("State: `verified`");
    expect((await readFile(path.join(root, "STATUS.md"), "utf8"))).not.toContain("State: `accepted`");
  });

  it("parses configured commands but does not execute them during non-opt-in verification", async () => {
    const root = await initializedProject("No implicit command execution");
    const sentinel = path.join(root, "must-not-exist.txt");
    await writeFile(
      path.join(root, "ACCEPTANCE.yaml"),
      `version: 1\ncommands:\n  - id: forbidden-side-effect\n    command: touch\n    args:\n      - ${JSON.stringify(sentinel)}\n`,
      "utf8"
    );

    const report = await verifyProject(root);

    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "acceptance:syntax", status: "pass" })
    );
    await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails freshness verification when a source changes after its review packet was frozen", async () => {
    const root = await initializedProject("Stale source");
    await writeFile(path.join(root, "analysis.md"), "reviewed version\n", "utf8");
    await freezePacket(root, "reviewed", ["analysis.md"]);
    await writeFile(path.join(root, "analysis.md"), "changed after review\n", "utf8");

    const report = await verifyProject(root);
    const freshness = report.checks.find(
      (check) => check.id === "packet:reviewed:source:analysis.md"
    );

    expect(report.passed).toBe(false);
    expect(freshness).toMatchObject({ status: "fail" });
    expect(freshness?.message).toMatch(/changed after freeze|stale/i);
    expect((await readEvents(root)).at(-1)).toMatchObject({
      type: "verification",
      status: "failed",
      depends_on: [expect.any(String)],
      metadata: {
        passed: false,
        packet_event_ids: [expect.any(String)]
      }
    });
    const events = await readEvents(root);
    expect(events.at(-1)?.depends_on).toEqual([
      events.find((event) => event.type === "packet_frozen")?.event_id
    ]);
  });

  it("requires explicit resolution of every blocker before named acceptance", async () => {
    const root = await initializedProject("Acceptance blocker gate");
    await writeFile(path.join(root, "analysis.md"), "accepted candidate\n", "utf8");
    await freezePacket(root, "accepted-candidate", ["analysis.md"]);
    const initialVerification = await verifyProject(root);
    expect(initialVerification.passed).toBe(true);
    await writeFile(
      path.join(root, "ACCEPTANCE.yaml"),
      `version: 1\ncommands: []\nhuman_approvals:\n  - id: scientific-acceptance\n    required: true\n    status: approved\n    authority: test-authority\n    accepts:\n      verification_event_id: ${initialVerification.verification_event_id}\n      verification_event_hash: ${initialVerification.verification_event_hash}\n`,
      "utf8"
    );
    const blocker = await appendEvent(root, {
      type: "blocked",
      actor: { id: "reviewer", role: "reviewer" },
      status: "blocked",
      summary: "Acceptance must wait for a missing source."
    });

    await expectErrorCode(
      recordAcceptance(root, "test-authority", "Premature acceptance."),
      "UNRESOLVED_BLOCKER"
    );
    expect((await projectSummary(root)).state).toBe("blocked");
    await resolveBlocks(root, "test-authority", [blocker.event_id], "Source supplied.");
    await expectErrorCode(
      recordAcceptance(root, "test-authority", "Old verification is no longer current."),
      "VERIFICATION_NOT_CURRENT"
    );
    const currentVerification = await verifyProject(root);
    await writeFile(
      path.join(root, "ACCEPTANCE.yaml"),
      `version: 1\ncommands: []\nhuman_approvals:\n  - id: scientific-acceptance\n    required: true\n    status: approved\n    authority: test-authority\n    accepts:\n      verification_event_id: ${currentVerification.verification_event_id}\n      verification_event_hash: ${currentVerification.verification_event_hash}\n`,
      "utf8"
    );
    const acceptance = await recordAcceptance(
      root,
      "test-authority",
      "Accepted after explicit blocker resolution."
    );
    expect(acceptance.type).toBe("acceptance");
    expect((await projectSummary(root)).state).toBe("accepted");
  });

  it("P1-1 rejects reuse of an approved document for a later verification", async () => {
    const root = await initializedProject("Approval target binding");
    await writeFile(path.join(root, "candidate.md"), "candidate v1\n", "utf8");
    await freezePacket(root, "candidate-v1", ["candidate.md"]);
    const firstVerification = await verifyProject(root);
    const approval = `version: 1\ncommands: []\nhuman_approvals:\n  - id: scientific-acceptance\n    required: true\n    status: approved\n    authority: test-authority\n    accepts:\n      verification_event_id: ${firstVerification.verification_event_id}\n      verification_event_hash: ${firstVerification.verification_event_hash}\n`;
    await writeFile(path.join(root, "ACCEPTANCE.yaml"), approval, "utf8");
    await recordAcceptance(root, "test-authority", "Accepted v1.");

    const secondVerification = await verifyProject(root);
    expect(secondVerification.verification_event_id).not.toBe(
      firstVerification.verification_event_id
    );
    await expectErrorCode(
      recordAcceptance(root, "test-authority", "Must not reuse the v1 approval."),
      "VERIFICATION_NOT_CURRENT"
    );
  });

  it("records a low-authority provisional review without unlocking packaging", async () => {
    const root = await initializedProject("Asynchronous human confirmation");
    await writeFile(path.join(root, "candidate.md"), "review while the human sleeps\n", "utf8");
    await freezePacket(root, "overnight-candidate", ["candidate.md"]);
    const verification = await verifyProject(root);
    const provisional = await recordProvisionalReview(
      root,
      "overnight-agent",
      verification.verification_event_id,
      "Automated checks passed; the researcher must inspect the candidate on waking.",
      "next wake-up"
    );
    expect(provisional).toMatchObject({
      type: "provisional_review",
      metadata: {
        requires_human_confirmation: true,
        authorizes_acceptance: false,
        authorizes_packaging: false
      }
    });
    await expectErrorCode(
      packageHandoff(root, "premature-package", ["candidate.md"]),
      "ACCEPTANCE_REQUIRED"
    );
    expect(await projectSummary(root)).toMatchObject({
      attention_required: true,
      human_review: {
        status: "awaiting_human_confirmation",
        verification_event_id: verification.verification_event_id,
        provisional_review_event_ids: [provisional.event_id]
      }
    });
    const queue = await readFile(path.join(root, "HUMAN_REVIEW_QUEUE.md"), "utf8");
    expect(queue).toContain("awaiting_human_confirmation");
    expect(queue).toContain(verification.verification_event_id);
    expect(queue).toContain("next wake-up");

    await writeFile(
      path.join(root, "ACCEPTANCE.yaml"),
      `version: 1\ncommands: []\nhuman_approvals:\n  - id: scientific-acceptance\n    required: true\n    status: approved\n    authority: test-authority\n    accepts:\n      verification_event_id: ${verification.verification_event_id}\n      verification_event_hash: ${verification.verification_event_hash}\n`,
      "utf8"
    );
    await recordAcceptance(root, "test-authority", "Confirmed after waking.");
    expect(await projectSummary(root)).toMatchObject({
      attention_required: false,
      human_review: null
    });
    expect(await readFile(path.join(root, "HUMAN_REVIEW_QUEUE.md"), "utf8")).toContain(
      "No human review item is currently pending."
    );
  });

  it("marks a passing verification stale when later agent work changes the ledger", async () => {
    const root = await initializedProject("Reverification queue");
    await writeFile(path.join(root, "candidate.md"), "candidate\n", "utf8");
    await freezePacket(root, "queue-candidate", ["candidate.md"]);
    const verification = await verifyProject(root);
    const later = await appendEvent(root, {
      type: "agent_contribution",
      actor: { id: "later-agent", role: "later reviewer" },
      summary: "Work continued after deterministic verification."
    });
    expect(await projectSummary(root)).toMatchObject({
      attention_required: true,
      human_review: {
        status: "reverification_required",
        superseded_verification_event_id: verification.verification_event_id,
        invalidating_event_ids: [later.event_id]
      }
    });
    expect(await readFile(path.join(root, "HUMAN_REVIEW_QUEUE.md"), "utf8")).toContain(
      "reverification_required"
    );
  });

  it("P1-3 blocks verification until every disclosed finding is adjudicated", async () => {
    const root = await initializedProject("Complete finding coverage");
    const review = await appendEvent(root, {
      type: "agent_contribution",
      actor: { id: "independent-reviewer", role: "independent reviewer" },
      summary: "Two findings require explicit dispositions.",
      findings: [
        {
          id: "coverage-one",
          severity: "high",
          claim: "First test finding.",
          evidence: [],
          uncertainty: "Synthetic.",
          remediation: "Adjudicate it."
        },
        {
          id: "coverage-two",
          severity: "critical",
          claim: "Second test finding.",
          evidence: [],
          uncertainty: "Synthetic.",
          remediation: "Adjudicate it too."
        }
      ]
    });
    await appendEvent(root, {
      type: "adjudication",
      actor: { id: "independent-adjudicator", role: "evidence adjudicator" },
      depends_on: [review.event_id],
      summary: "Only one finding was handled.",
      decisions: [
        {
          finding_id: "coverage-one",
          disposition: "accept",
          rationale: "The first finding is supported."
        }
      ]
    });

    const partial = await verifyProject(root);
    expect(partial.passed).toBe(false);
    expect(partial.checks).toContainEqual(
      expect.objectContaining({ id: "findings:coverage", status: "fail" })
    );

    await appendEvent(root, {
      type: "adjudication",
      actor: { id: "second-adjudicator", role: "evidence adjudicator" },
      depends_on: [review.event_id],
      summary: "The remaining finding was handled.",
      decisions: [
        {
          finding_id: "coverage-two",
          disposition: "accept",
          rationale: "The second finding is supported."
        }
      ]
    });
    const complete = await verifyProject(root);
    expect(complete.passed).toBe(true);
    expect(complete.checks).toContainEqual(
      expect.objectContaining({ id: "findings:coverage", status: "pass" })
    );
  });

  it("P1-3 rejects self-adjudication", async () => {
    const root = await initializedProject("Independent adjudication");
    const review = await appendEvent(root, {
      type: "agent_contribution",
      actor: { id: "same-actor", role: "reviewer" },
      summary: "A finding authored by the future adjudicator.",
      findings: [
        {
          id: "self-finding",
          severity: "medium",
          claim: "Synthetic self-adjudication finding.",
          evidence: [],
          uncertainty: "Synthetic.",
          remediation: "Use a distinct adjudicator."
        }
      ]
    });
    await expectErrorCode(
      appendEvent(root, {
        type: "adjudication",
        actor: { id: "same-actor", role: "evidence adjudicator" },
        depends_on: [review.event_id],
        summary: "An actor must not adjudicate its own finding.",
        decisions: [
          {
            finding_id: "self-finding",
            disposition: "reject",
            rationale: "This disposition is not independent."
          }
        ]
      }),
      "SELF_ADJUDICATION"
    );
  });

  it("P1-2 verifies an explicit revision while retaining old packet integrity", async () => {
    const root = await initializedProject("Explicit packet supersession");
    await writeFile(path.join(root, "result.txt"), "version one\n", "utf8");
    await freezePacket(root, "revision-v1", ["result.txt"]);
    await writeFile(path.join(root, "result.txt"), "version two\n", "utf8");
    await freezePacket(root, "revision-v2", ["result.txt"], ["revision-v1"]);

    const current = await verifyProject(root);
    expect(current.passed).toBe(true);
    expect(current.checks).toContainEqual(
      expect.objectContaining({
        id: "packet:revision-v1:freshness",
        status: "not_applicable"
      })
    );
    const packetEvents = (await readEvents(root)).filter(
      (event) => event.type === "packet_frozen"
    );
    expect((await readEvents(root)).at(-1)?.depends_on).toContain(
      packetEvents.find((event) => event.metadata["packet_id"] === "revision-v2")
        ?.event_id
    );
    expect((await readEvents(root)).at(-1)?.depends_on).not.toContain(
      packetEvents.find((event) => event.metadata["packet_id"] === "revision-v1")
        ?.event_id
    );

    await writeFile(
      path.join(root, ".research", "frozen", "revision-v1", "files", "result.txt"),
      "tampered historical bytes\n",
      "utf8"
    );
    const tampered = await verifyProject(root);
    expect(tampered.passed).toBe(false);
    expect(tampered.checks).toContainEqual(
      expect.objectContaining({ id: "packet:revision-v1:integrity", status: "fail" })
    );
  });
});
