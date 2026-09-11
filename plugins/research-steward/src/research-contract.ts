import { createHash } from "node:crypto";
import { z } from "zod";
import { IdentifierSchema, type CommittedEvent } from "./protocol.js";
import { EvidenceLocatorSchema } from "./evidence.js";
import { ResearchStewardError, stableJson } from "./utils.js";

/**
 * Frozen research contract (DESIGN-RESEARCH-CONTRACT, module layer).
 * contract_frozen protocol event + storage stay on the shared-surface gate;
 * this file owns schema, hash, scope-drift, and fold helpers.
 */

export const CONTRACT_PROFILES = [
  "general",
  "experimental",
  "observational",
  "model_simulation",
  "literature_review"
] as const;

export type ContractProfile = (typeof CONTRACT_PROFILES)[number];

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

export const PreregisteredHypothesisSchema = z
  .object({
    hypothesis_id: IdentifierSchema,
    statement: z.string().min(1).max(4_000),
    linked_outcome: z.string().min(1).max(2_000),
    direction: z
      .enum(["increase", "decrease", "two_sided", "non_inferiority"])
      .optional()
  })
  .strict();

export const MethodCommitmentSchema = z
  .object({
    id: IdentifierSchema,
    statement: z.string().min(1).max(4_000),
    verification: z.enum(["machine", "human"])
  })
  .strict();

export const DeliverableSchema = z
  .object({
    deliverable_id: IdentifierSchema,
    kind: z.enum(["report", "dataset", "figure", "code", "package", "other"]),
    description: z.string().min(1).max(2_000),
    required: z.boolean().default(true)
  })
  .strict();

const QuestionSchema = z.string().min(1).max(4_000);
const ScopeSchema = z.string().min(1).max(2_000);
const EstimandSchema = z.string().min(1).max(2_000);
const PopulationSchema = z.string().min(1).max(2_000);
const InterventionSchema = z.string().min(1).max(2_000);
const ComparatorSchema = z.string().min(1).max(2_000);
const OutcomeSchema = z.string().min(1).max(2_000);
const TimeSchema = z.string().min(1).max(1_000);
const UnitSchema = z.string().min(1).max(1_000);
const StructuredLocatorSchema = EvidenceLocatorSchema.refine(
  (loc) => loc.kind !== "free_text",
  { message: "data_cut.locator must not be free_text (R1.2)" }
);

const DataCutSchema = z
  .object({
    label: z.string().min(1).max(200),
    locator: StructuredLocatorSchema
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
    method_commitments: z.array(MethodCommitmentSchema).max(64).default([]),
    hypotheses: z.array(PreregisteredHypothesisSchema).max(64).default([]),
    deliverables: z.array(DeliverableSchema).max(64).default([]),
    analysis_class: z.enum(["exploratory", "confirmatory"]),
    created_at: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((contract, ctx) => {
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
    // Architect ruling 1: confirmatory without preregistered hypotheses is
    // rejected at parse time (contract incompleteness, not conclusion judging).
    if (contract.analysis_class === "confirmatory" && contract.hypotheses.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "confirmatory contracts require at least one preregistered hypothesis",
        path: ["hypotheses"]
      });
    }
    const hypIds = new Set<string>();
    for (const h of contract.hypotheses) {
      if (hypIds.has(h.hypothesis_id)) {
        ctx.addIssue({
          code: "custom",
          message: "hypothesis_id values must be unique",
          path: ["hypotheses"]
        });
        break;
      }
      hypIds.add(h.hypothesis_id);
    }
    const delIds = new Set<string>();
    for (const d of contract.deliverables) {
      if (delIds.has(d.deliverable_id)) {
        ctx.addIssue({
          code: "custom",
          message: "deliverable_id values must be unique",
          path: ["deliverables"]
        });
        break;
      }
      delIds.add(d.deliverable_id);
    }
  });

export type ResearchContract = z.infer<typeof ResearchContractSchema>;

/** Architect ruling 2: created_at is part of contract identity. */
export function contractHash(contract: ResearchContract): string {
  return createHash("sha256").update(stableJson(contract), "utf8").digest("hex");
}

export function parseResearchContract(raw: unknown): ResearchContract {
  return ResearchContractSchema.parse(raw);
}

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

/**
 * Deprecated (CR-M-074 R1.1): boolean API superseded by evaluateScopeDrift
 * machine-hint layer. Kept as a thin wrapper for existing callers.
 */
export function detectScopeDrift(
  contract: ResearchContract,
  claimText: string
): { drifted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (isNotApplicable(contract.outcome) || isNotApplicable(contract.population)) {
    return { drifted: false, reasons };
  }
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

/**
 * Fold contract_frozen events (injected until protocol step). Returns the
 * latest contract hash in the stream, or null.
 */
export function foldActiveContractHash(
  events: readonly CommittedEvent[]
): string | null {
  let latest: string | null = null;
  for (const event of events) {
    if ((event.type as string) !== "contract_frozen") continue;
    const h = event.metadata["contract_hash"];
    if (typeof h === "string") latest = h;
  }
  return latest;
}

/** Architect ruling 5: later packet must bind the active contract hash. */
export function assertPacketBindsContract(
  activeContractHash: string | null,
  packetMetadata: Record<string, unknown>
): void {
  if (activeContractHash === null) return; // legacy project without contracts
  const bound = packetMetadata["contract_hash"];
  if (typeof bound !== "string" || bound !== activeContractHash) {
    throw new ResearchStewardError(
      "CONTRACT_BINDING_REQUIRED",
      "packet_frozen after contract_frozen must carry the active contract_hash.",
      { active: activeContractHash }
    );
  }
}


/** R1.1 machine-hint layer: never a verdict — only hints for human adjudication. */
export const ScopeDeclarationSchema = z
  .object({
    population_note: z.string().max(2_000).optional(),
    outcome_note: z.string().max(2_000).optional(),
    unit_note: z.string().max(2_000).optional(),
    known_limits: z.array(z.string().max(1_000)).max(32).default([])
  })
  .strict();

export type ScopeDeclaration = z.infer<typeof ScopeDeclarationSchema>;

export function evaluateScopeDrift(
  contract: ResearchContract,
  declaration: ScopeDeclaration,
  claimText: string
): { machine_hints: string[]; needs_human_adjudication: boolean } {
  const hints: string[] = [];
  const expansion = /\b(all humans|everyone worldwide|any species|universal effect)\b/i;
  if (expansion.test(claimText)) {
    hints.push("claim-language-expands-population");
  }
  if (contract.analysis_class === "exploratory" && /\b(proves|confirms|definitively)\b/i.test(claimText)) {
    hints.push("exploratory-contract-confirmatory-language");
  }
  if (declaration.known_limits.length > 0) {
    hints.push("declaration-has-acknowledged-limits");
  }
  return {
    machine_hints: hints,
    needs_human_adjudication: hints.some((h) => h !== "declaration-has-acknowledged-limits")
  };
}


/**
 * CR-M-074: verify precheck — a scope declaration must have been reviewed
 * by a checker event before acceptance can proceed.
 */
export function assertScopeDeclarationChecked(input: {
  declaration_present: boolean;
  checker_event_present: boolean;
}): void {
  if (input.declaration_present && !input.checker_event_present) {
    throw new ResearchStewardError(
      "SCOPE_DECLARATION_UNCHECKED",
      "A scope declaration exists but no checker event has reviewed it."
    );
  }
}
