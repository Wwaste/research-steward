import { describe, expect, it } from "vitest";
import {
  assertContractUnchanged,
  assertPacketBindsContract,
  contractHash,
  detectScopeDrift,
  foldActiveContractHash,
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
    data_cut: {
      label: "cut-a",
      locator: { kind: "dataset_record", dataset_id: "ds", record_key: "k" }
    },
    assumptions: ["SUTVA"],
    analysis_class: "exploratory",
    created_at: "2026-09-10T00:00:00.000Z",
    ...overrides
  };
}

describe("research contract (DESIGN-RESEARCH-CONTRACT module layer)", () => {
  it("parses with method commitments, hypotheses, deliverables", () => {
    const c = parseResearchContract(
      baseContract({
        method_commitments: [{ id: "m1", statement: "ITT", verification: "machine" }],
        deliverables: [{ deliverable_id: "d1", kind: "report", description: "final" }]
      })
    );
    expect(c.method_commitments).toHaveLength(1);
    expect(c.deliverables[0]!.required).toBe(true);
    expect(contractHash(c)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects confirmatory without preregistered hypotheses (architect ruling 1)", () => {
    expect(() =>
      parseResearchContract(baseContract({ analysis_class: "confirmatory" }))
    ).toThrowError(/hypothesis/i);
    expect(() =>
      parseResearchContract(
        baseContract({
          analysis_class: "confirmatory",
          hypotheses: [
            {
              hypothesis_id: "h1",
              statement: "X reduces Y",
              linked_outcome: "Y score",
              direction: "decrease"
            }
          ]
        })
      )
    ).not.toThrow();
  });

  it("contractHash includes created_at (architect ruling 2)", () => {
    const a = parseResearchContract(baseContract());
    const b = parseResearchContract(
      baseContract({ created_at: "2026-09-11T00:00:00.000Z" })
    );
    expect(contractHash(a)).not.toBe(contractHash(b));
  });

  it("still requires not_applicable+reason and experimental fields", () => {
    expect(() => parseResearchContract(baseContract({ comparator: "" }))).toThrow();
    const na = parseResearchContract(
      baseContract({
        profile: "observational",
        intervention_exposure: "Exposure A",
        comparator: { not_applicable: true, reason: "single-arm" }
      })
    );
    expect(isNotApplicable(na.comparator)).toBe(true);
  });

  it("detects scope drift and post-hoc confirmatory language", () => {
    const contract = parseResearchContract(baseContract());
    const drift = detectScopeDrift(
      contract,
      "This proves all humans worldwide benefit from X."
    );
    expect(drift.drifted).toBe(true);
  });

  it("folds contract_frozen stream and binds packets (injected events)", () => {
    expect(foldActiveContractHash([])).toBeNull();
    const events = [
      {
        type: "contract_frozen",
        metadata: { contract_hash: "a".repeat(64) }
      },
      {
        type: "contract_frozen",
        metadata: { contract_hash: "b".repeat(64), supersedes_contract_hash: "a".repeat(64) }
      }
    ] as never;
    const active = foldActiveContractHash(events as never);
    expect(active).toBe("b".repeat(64));
    expect(() =>
      assertPacketBindsContract(active, { contract_hash: "b".repeat(64) })
    ).not.toThrow();
    expect(() => assertPacketBindsContract(active, {})).toThrowError(
      expect.objectContaining({ code: "CONTRACT_BINDING_REQUIRED" })
    );
    // legacy project without any contract: no binding required
    expect(() => assertPacketBindsContract(null, {})).not.toThrow();
  });

  it("treats a changed contract as requiring a new packet", () => {
    const a = parseResearchContract(baseContract());
    const b = parseResearchContract(baseContract({ outcome: "Different" }));
    expect(() => assertContractUnchanged(a, a)).not.toThrow();
    expect(() => assertContractUnchanged(a, b)).toThrowError(
      expect.objectContaining({ code: "RESEARCH_CONTRACT_CHANGED" })
    );
  });
});


describe("CR-M-074 R1 contract", () => {
  it("rejects free_text data_cut locator", () => {
    expect(() =>
      parseResearchContract(
        baseContract({
          data_cut: {
            label: "cut",
            locator: { kind: "free_text", text: "somewhere", legacy: true }
          }
        })
      )
    ).toThrow();
  });

  it("rejects unknown fields, unknown profile, experimental not_applicable", () => {
    expect(() => parseResearchContract(baseContract({ extra: 1 }))).toThrow();
    expect(() => parseResearchContract(baseContract({ profile: "magic" }))).toThrow();
    expect(() =>
      parseResearchContract(
        baseContract({
          intervention_exposure: { not_applicable: true, reason: "oops" }
        })
      )
    ).toThrow();
  });

  it("literature_review profile positive case", () => {
    const c = parseResearchContract(
      baseContract({
        profile: "literature_review",
        intervention_exposure: { not_applicable: true, reason: "no intervention" },
        comparator: { not_applicable: true, reason: "narrative" },
        unit: "study",
        estimand: "Reported effect sizes"
      })
    );
    expect(c.profile).toBe("literature_review");
  });

  it("evaluateScopeDrift returns machine hints not a verdict", async () => {
    const { evaluateScopeDrift } = await import("../src/research-contract.js");
    const c = parseResearchContract(baseContract());
    const r = evaluateScopeDrift(
      c,
      { known_limits: ["single site"] },
      "This proves all humans worldwide benefit."
    );
    expect(r.machine_hints).toContain("claim-language-expands-population");
    expect(r.needs_human_adjudication).toBe(true);
  });
});


describe("CR-M-074 remainder", () => {
  it("rejects duplicate hypothesis ids and illegal discriminant", async () => {
    expect(() =>
      parseResearchContract(
        baseContract({
          analysis_class: "confirmatory",
          hypotheses: [
            { hypothesis_id: "h1", statement: "a", linked_outcome: "o" },
            { hypothesis_id: "h1", statement: "b", linked_outcome: "o" }
          ]
        })
      )
    ).toThrow();
    expect(() =>
      parseResearchContract(baseContract({ data_cut: { label: "c", locator: { kind: "nope" } } }))
    ).toThrow();
  });

  it("assertScopeDeclarationChecked fails without checker event", async () => {
    const { assertScopeDeclarationChecked } = await import("../src/research-contract.js");
    expect(() =>
      assertScopeDeclarationChecked({ declaration_present: true, checker_event_present: false })
    ).toThrowError(expect.objectContaining({ code: "SCOPE_DECLARATION_UNCHECKED" }));
    expect(() =>
      assertScopeDeclarationChecked({ declaration_present: true, checker_event_present: true })
    ).not.toThrow();
  });
});
