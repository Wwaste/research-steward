import { describe, expect, it } from "vitest";
import { openFinding, transitionFinding } from "../src/findings.js";

function finding() {
  return openFinding({
    finding_id: "F1",
    severity: "important",
    title: "Something wrong",
    packet_id: "p1"
  });
}

describe("finding lifecycle (Task 2.6)", () => {
  it("requires evidence and adjudicator to mark fixed", () => {
    const f = finding();
    expect(() => transitionFinding(f, "fixed", { adjudicator: "rev" })).toThrowError(
      expect.objectContaining({ code: "FINDING_FIXED_REQUIRES_EVIDENCE" })
    );
    expect(() =>
      transitionFinding(f, "fixed", {
        remediation_evidence: "commit abc + tests green"
      })
    ).toThrowError(expect.objectContaining({ code: "FINDING_ADJUDICATOR_REQUIRED" }));
    const fixed = transitionFinding(f, "fixed", {
      adjudicator: "rev-1",
      remediation_evidence: "commit abc + tests green"
    });
    expect(fixed.state).toBe("fixed");
    expect(fixed.adjudicator).toBe("rev-1");
  });

  it("rejects illegal transitions", () => {
    const f = finding();
    const deferred = transitionFinding(f, "deferred", {});
    expect(() => transitionFinding(deferred, "fixed", {
      adjudicator: "x",
      remediation_evidence: "y"
    })).not.toThrow();
  });
});
