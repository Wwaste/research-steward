import { describe, expect, it } from "vitest";
import {
  assertFixedRequiresEvidence,
  assertSelfAdjudication,
  foldFindings,
  isLegalFindingTransition
} from "../src/findings.js";
import type { CommittedEvent } from "../src/protocol.js";

function contribution(seq: number, findings: unknown[]): CommittedEvent {
  return {
    event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    sequence: seq,
    type: "agent_contribution",
    actor: { id: "reporter", role: "reviewer" },
    status: "complete",
    summary: "s",
    findings,
    metadata: {},
    created_at: "2026-09-11T00:00:00.000Z",
    project_id: "11111111-1111-4111-8111-111111111111",
    event_hash: "a".repeat(64),
    previous_event_hash: null
  } as unknown as CommittedEvent;
}

function transition(
  seq: number,
  fromEvent: string,
  findingId: string,
  to: string,
  actor = "adjudicator"
): CommittedEvent {
  return {
    event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    sequence: seq,
    type: "finding_transition",
    actor: { id: actor, role: "adjudicator" },
    status: "complete",
    summary: "t",
    metadata: {
      finding_event_id: fromEvent,
      finding_id: findingId,
      from: "open",
      to,
      reason: "r",
      fixed_in_packet_id: "pkt",
      expires_at: "2027-01-01T00:00:00.000Z",
      remediation_evidence_fingerprints: ["b".repeat(64)]
    },
    created_at: "2026-09-11T00:00:01.000Z",
    project_id: "11111111-1111-4111-8111-111111111111",
    event_hash: "c".repeat(64),
    previous_event_hash: "a".repeat(64)
  } as unknown as CommittedEvent;
}

const declareId = "00000000-0000-4000-8000-000000000001";

describe("finding fold (DESIGN-EVIDENCE §3)", () => {
  it("reports → open via adjudication-style transition", () => {
    const map = foldFindings([
      contribution(1, [{ id: "F1", severity: "high", claim: "c" }]),
      {
        ...transition(2, declareId, "F1", "open"),
        metadata: { finding_event_id: declareId, finding_id: "F1", from: "reported", to: "open", reason: "accept" }
      } as CommittedEvent
    ]);
    const snap = map.get(`${declareId}:F1`)!;
    expect(snap.state).toBe("open");
    expect(snap.reporter_actor_id).toBe("reporter");
  });

  it("rejects illegal transitions at matrix level", () => {
    expect(isLegalFindingTransition("deferred", "fixed")).toBe(false);
    expect(isLegalFindingTransition("open", "fixed")).toBe(true);
    expect(isLegalFindingTransition("obsolete", "open")).toBe(false);
  });

  it("self-adjudication is rejected", () => {
    const snap = foldFindings([
      contribution(1, [{ id: "F1", severity: "info", claim: "c" }])
    ]).get(`${declareId}:F1`)!;
    expect(() => assertSelfAdjudication(snap, "reporter")).toThrowError(
      expect.objectContaining({ code: "SELF_ADJUDICATION" })
    );
  });

  it("fixed requires fingerprints + packet; accepted_risk requires expiry", () => {
    expect(() =>
      assertFixedRequiresEvidence({
        finding_event_id: declareId,
        finding_id: "F1",
        reporter_actor_id: "r",
        severity: "info",
        claim: "c",
        state: "fixed",
        adjudicator_actor_id: "a",
        remediation_evidence_fingerprints: [],
        fixed_in_packet_id: null,
        expires_at: null,
        last_transition_event_id: null,
        open_diff_review_id: null,
        locator_path: null
      })
    ).toThrowError(expect.objectContaining({ code: "FINDING_FIXED_REQUIRES_EVIDENCE" }));
    expect(() =>
      assertFixedRequiresEvidence({
        finding_event_id: declareId,
        finding_id: "F1",
        reporter_actor_id: "r",
        severity: "info",
        claim: "c",
        state: "accepted_risk",
        adjudicator_actor_id: "a",
        remediation_evidence_fingerprints: [],
        fixed_in_packet_id: null,
        expires_at: null,
        last_transition_event_id: null,
        open_diff_review_id: null,
        locator_path: null
      })
    ).toThrowError(
      expect.objectContaining({ code: "FINDING_ACCEPTED_RISK_REQUIRES_EXPIRY" })
    );
  });
});


describe("CR-M-077 P5 locator priority", () => {
  it("structured locator wins even when v1 string appears first", async () => {
    const { extractLocatorPath } = await import("../src/findings.js");
    const p = extractLocatorPath({
      evidence: [
        { locator: "methods section", kind: "source" },
        {
          kind: "structured",
          locator: { kind: "file_range", path: "data/t.csv" }
        }
      ]
    });
    expect(p).toBe("data/t.csv");
  });
});
