import { createHash } from "node:crypto";
import { z } from "zod";
import { ResearchStewardError, stableJson } from "./utils.js";

/**
 * Frozen research contract (Task 3.1). The contract is versioned content that
 * freeze/roundtable will depend on: changing it requires a new packet, never a
 * rewrite of the prior conclusion's context.
 */

export const CONTRACT_PROFILES = [
  "general",
  "experimental",
  "observational",
  "model_simulation",
  "literature_review"
] as const;

export type ContractProfile = (typeof CONTRACT_PROFILES)[number];

/** A field that does not apply must say so explicitly with a reason. */
export const NotApplicableSchema = z
  .object({
    not_applicable: z.literal(true),
    reason: z.string().min(1).max(2_000)
  })
  .strict();

export function fieldOrNotApplicable<T extends z.ZodTypeAny>(
  field: T
): z.ZodUnion<[T, z.ZodType<z.infer<typeof NotApplicableSchema>>]> {
  return z.union([field, NotApplicableSchema]);
}

export function isNotApplicable(
  value: unknown
): value is z.infer<typeof NotApplicableSchema> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { not_applicable?: unknown }).not_applicable === true
  );
}

const QuestionSchema = z.string().min(1).max(4_000);
const ScopeSchema = z.string().min(1).max(2_000);
const EstimandSchema = z.string().min(1).max(2_000);
const PopulationSchema = z.string().min(1).max(2_000);
const InterventionSchema = z.string().min(1).max(2_000);
const ComparatorSchema = z.string().min(1).max(2_000);
const OutcomeSchema = z.string().min(1).max(2_000);
const TimeSchema = z.string().min(1).max(1_000);
const UnitSchema = z.string().min(1).max(1_000);
const DataCutSchema = z
  .object({
    label: z.string().min(1).max(200),
    identity: z.string().min(1).max(500)
  })
  .strict();
const AssumptionsSchema = z.array(z.string().min(1).max(2_000)).max(64);

export const ResearchContractSchema = z
  .object({
    contract_version: z.literal(1),
    profile: z.enum(CONTRACT_PROFILES),
    question: fieldOrNotApplicable(QuestionSchema),
    claim_scope: fieldOrNotApplicable(ScopeSchema),
    estimand: fieldOrNotApplicable(EstimandSchema),
    population: fieldOrNotApplicable(PopulationSchema),
    intervention_exposure: fieldOrNotApplicable(InterventionSchema),
    comparator: fieldOrNotApplicable(ComparatorSchema),
    outcome: fieldOrNotApplicable(OutcomeSchema),
    time: fieldOrNotApplicable(TimeSchema),
    unit: fieldOrNotApplicable(UnitSchema),
    data_cut: fieldOrNotApplicable(DataCutSchema),
    assumptions: fieldOrNotApplicable(AssumptionsSchema),
    analysis_class: z.enum(["exploratory", "confirmatory"]),
    created_at: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((contract, ctx) => {
    // Profile-specific required fields: experimental needs
    // intervention+comparator; observational needs exposure; both need outcome
    // and unit unless explicitly not_applicable with a reason (already typed).
    if (contract.profile === "experimental") {
      if (isNotApplicable(contract.intervention_exposure)) {
        ctx.addIssue({
          code: "custom",
          message: "experimental contracts require an intervention_exposure",
          path: ["intervention_exposure"]
        });
      }
      if (isNotApplicable(contract.comparator)) {
        ctx.addIssue({
          code: "custom",
          message: "experimental contracts require a comparator",
          path: ["comparator"]
        });
      }
    }
    if (contract.profile === "observational" && isNotApplicable(contract.intervention_exposure)) {
      ctx.addIssue({
        code: "custom",
        message: "observational contracts require an exposure field",
        path: ["intervention_exposure"]
      });
    }
  });

export type ResearchContract = z.infer<typeof ResearchContractSchema>;

export function contractHash(contract: ResearchContract): string {
  return createHash("sha256").update(stableJson(contract), "utf8").digest("hex");
}

export function parseResearchContract(raw: unknown): ResearchContract {
  return ResearchContractSchema.parse(raw);
}

/**
 * A contract change invalidates prior conclusion context: callers must freeze
 * a new packet. Compare two contracts by content hash.
 */
export function assertContractUnchanged(
  previous: ResearchContract,
  next: ResearchContract
): void {
  if (contractHash(previous) !== contractHash(next)) {
    throw new ResearchStewardError(
      "RESEARCH_CONTRACT_CHANGED",
      "The research contract changed; freeze a new packet instead of rewriting prior conclusion context."
    );
  }
}

/** Scope drift: claim text that names a population/outcome outside the contract. */
export function detectScopeDrift(
  contract: ResearchContract,
  claimText: string
): { drifted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (isNotApplicable(contract.outcome) || isNotApplicable(contract.population)) {
    return { drifted: false, reasons };
  }
  // Lightweight lexical check: flag explicit expansion markers, not NLP.
  const expansion = /\b(all humans|everyone worldwide|any species|universal effect)\b/i;
  if (expansion.test(claimText)) {
    reasons.push("claim language expands beyond the contract population");
  }
  if (contract.analysis_class === "exploratory") {
    const confirmatory = /\b(proves|confirms|definitively)\b/i;
    if (confirmatory.test(claimText)) {
      reasons.push("exploratory contract used with confirmatory claim language");
    }
  }
  return { drifted: reasons.length > 0, reasons };
}
