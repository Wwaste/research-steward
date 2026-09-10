import { describe, expect, it } from "vitest";
import {
  ResearchContractSchema,
  assertContractUnchanged,
  contractHash,
  detectScopeDrift,
  isNotApplicable,
  parseResearchContract
} from "../src/research-contract.js";

function baseContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract_version: 1,
    profile: "experimental",
    question: "Does X reduce Y in Z?",
    claim_scope: "Adults in the trial cohort",
    estimand: "Average treatment effect on Y at 12 weeks",
    population: "Adults 18-65 meeting inclusion criteria",
    intervention_exposure: "X at 10mg daily",
    comparator: "Placebo",
    outcome: "Y score change from baseline",
    time: "12 weeks",
    unit: "participant",
    data_cut: { label: "cut-a", identity: "sha256:fixture" },
    assumptions: ["SUTVA", "no differential attrition by arm"],
    analysis_class: "confirmatory",
    created_at: "2026-09-10T00:00:00.000Z",
    ...overrides
  };
}

describe("research contract (Task 3.1)", () => {
  it("parses a full experimental contract", () => {
    const contract = parseResearchContract(baseContract());
    expect(contract.profile).toBe("experimental");
    expect(contractHash(contract)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires not_applicable + reason instead of empty strings", () => {
    const raw = baseContract({ comparator: "" });
    expect(() => parseResearchContract(raw)).toThrow();
    const na = parseResearchContract(
      baseContract({
        profile: "observational",
        intervention_exposure: "Exposure A",
        comparator: { not_applicable: true, reason: "single-arm feasibility run" }
      })
    );
    expect(isNotApplicable(na.comparator)).toBe(true);
  });

  it("rejects experimental contracts that mark intervention not_applicable", () => {
    expect(() =>
      parseResearchContract(
        baseContract({
          intervention_exposure: { not_applicable: true, reason: "oops" }
        })
      )
    ).toThrowError(expect.objectContaining({ name: "ZodError" }));
  });

  it("supports observational and literature_review profiles", () => {
    const obs = parseResearchContract(
      baseContract({
        profile: "observational",
        intervention_exposure: "Smoking status",
        comparator: { not_applicable: true, reason: "exposure contrast only" },
        analysis_class: "exploratory"
      })
    );
    expect(obs.profile).toBe("observational");
    const lit = parseResearchContract(
      baseContract({
        profile: "literature_review",
        intervention_exposure: { not_applicable: true, reason: "no intervention" },
        comparator: { not_applicable: true, reason: "narrative review" },
        unit: "study",
        estimand: "Reported effect sizes across included studies"
      })
    );
    expect(lit.unit).toBe("study");
  });

  it("detects scope drift and post-hoc confirmatory language", () => {
    const contract = parseResearchContract(
      baseContract({ analysis_class: "exploratory" })
    );
    const drift = detectScopeDrift(
      contract,
      "This proves all humans worldwide benefit from X."
    );
    expect(drift.drifted).toBe(true);
    expect(drift.reasons.join(" ")).toContain("population");
    expect(drift.reasons.join(" ")).toContain("confirmatory");
  });

  it("treats a changed contract as requiring a new packet", () => {
    const a = parseResearchContract(baseContract());
    const b = parseResearchContract(baseContract({ outcome: "Different primary outcome" }));
    expect(() => assertContractUnchanged(a, a)).not.toThrow();
    expect(() => assertContractUnchanged(a, b)).toThrowError(
      expect.objectContaining({ code: "RESEARCH_CONTRACT_CHANGED" })
    );
  });

  it("rejects unknown fields and unknown profile", () => {
    expect(() => parseResearchContract(baseContract({ extra: 1 }))).toThrow();
    expect(() =>
      parseResearchContract(baseContract({ profile: "magic" }))
    ).toThrow();
    expect(ResearchContractSchema.safeParse(baseContract()).success).toBe(true);
  });
});
