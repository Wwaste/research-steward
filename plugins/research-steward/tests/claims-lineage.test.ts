import { describe, expect, it } from "vitest";
import {
  addEvidenceLink,
  assertCausalSupport,
  coverageMap,
  emptyClaimMatrix,
  markStaleForSourceChange,
  parseClaimMatrix,
  upsertClaim,
  upsertLineageNode
} from "../src/claims.js";

const H = "b".repeat(64);

function claim(overrides: Record<string, unknown> = {}) {
  return {
    claim_id: "C1",
    type: "descriptive" as const,
    text: "Median Y was 3.2 in cohort A.",
    author: "author-role",
    created_at: "2026-09-10T00:00:00.000Z",
    ...overrides
  };
}

describe("claim-evidence matrix (Task 3.5)", () => {
  it("upserts claims and links evidence", () => {
    let matrix = emptyClaimMatrix();
    matrix = upsertClaim(matrix, claim() as never);
    matrix = addEvidenceLink(matrix, {
      claim_id: "C1",
      relation: "supports",
      evidence: {
        kind: "command_result",
        executable: "Rscript",
        argv: ["summarize.R"],
        cwd: "analysis/run",
        exit_code: 0,
        stdout_sha256: H,
        stderr_sha256: H
      },
      strength: "moderate"
    });
    expect(matrix.claims).toHaveLength(1);
    expect(matrix.links).toHaveLength(1);
    expect(parseClaimMatrix(matrix)).toEqual(matrix);
  });

  it("rejects links to unknown claims", () => {
    const matrix = emptyClaimMatrix();
    expect(() =>
      addEvidenceLink(matrix, {
        claim_id: "NOPE",
        relation: "supports",
        evidence: { kind: "doi", doi: "10.1234/abc" },
        strength: "weak"
      })
    ).toThrowError(expect.objectContaining({ code: "CLAIM_NOT_FOUND" }));
  });

  it("marks claims stale when upstream lineage changes (not auto-false)", () => {
    let matrix = emptyClaimMatrix();
    matrix = upsertClaim(matrix, claim() as never);
    matrix = upsertLineageNode(matrix, {
      node_id: "src1",
      kind: "source",
      label: "raw csv",
      identity: "sha256:old",
      depends_on: []
    });
    matrix = upsertLineageNode(matrix, {
      node_id: "tbl1",
      kind: "table",
      label: "table1",
      identity: "sha256:tbl",
      depends_on: ["src1"]
    });
    matrix = upsertLineageNode(matrix, {
      node_id: "mc1",
      kind: "manuscript_claim",
      label: "uses C1",
      identity: "C1",
      depends_on: ["tbl1"]
    });
    const { stale_claim_ids } = markStaleForSourceChange(matrix, ["src1"]);
    expect(stale_claim_ids).toContain("C1");
  });

  it("reports uncovered claims without promoting strength", () => {
    let matrix = emptyClaimMatrix();
    matrix = upsertClaim(matrix, claim() as never);
    const map = coverageMap(matrix);
    expect(map[0]).toMatchObject({ claim_id: "C1", uncovered: true, supports: 0 });
  });

  it("rejects causal claims supported only by weak evidence", () => {
    let matrix = emptyClaimMatrix();
    matrix = upsertClaim(matrix, claim({ type: "causal", claim_id: "CX" }) as never);
    matrix = addEvidenceLink(matrix, {
      claim_id: "CX",
      relation: "supports",
      evidence: { kind: "free_text", text: "looks causal", legacy: true },
      strength: "weak"
    });
    expect(() => assertCausalSupport(matrix)).toThrowError(
      expect.objectContaining({ code: "CAUSAL_CLAIM_UNDER_SUPPORTED" })
    );
  });

  it("rejects lineage deps on unknown nodes", () => {
    const matrix = emptyClaimMatrix();
    expect(() =>
      upsertLineageNode(matrix, {
        node_id: "x",
        kind: "analysis",
        label: "a",
        identity: "1",
        depends_on: ["missing"]
      })
    ).toThrowError(expect.objectContaining({ code: "LINEAGE_DEPENDENCY_MISSING" }));
  });
});
