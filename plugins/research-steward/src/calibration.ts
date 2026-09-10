import { createHash } from "node:crypto";
import { z } from "zod";
import { stableJson } from "./utils.js";

/**
 * Calibration benchmark scaffolding (Task 3.7). Gold labels must be
 * human/independent — never self-asserted by the model under test. CI only
 * runs zero-cost deterministic/fake subsets.
 */

export const BenchmarkCaseSchema = z
  .object({
    case_id: z.string().min(1).max(100),
    category: z.enum([
      "citation_mismatch",
      "numeric_closure",
      "figure_source",
      "statistical_assumption",
      "causal_overreach",
      "code_result_mismatch",
      "deliberately_unjudgeable"
    ]),
    packet_id: z.string().min(1).max(100),
    /** synthetic_expected_behavior until a human adjudicator is recorded. */
    gold_source: z.enum(["synthetic_expected_behavior", "human_adjudicated"]),
    expected_finding_ids: z.array(z.string().min(1).max(100)).max(64),
    acceptable_decisions: z.array(z.string().min(1).max(100)).max(32).default([]),
    adjudicator: z.string().min(1).max(100).nullable().default(null)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.gold_source === "human_adjudicated" && value.adjudicator === null) {
      ctx.addIssue({
        code: "custom",
        message: "human_adjudicated gold requires a named adjudicator",
        path: ["adjudicator"]
      });
    }
  });

export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;

export const EvalRunSchema = z
  .object({
    run_version: z.literal(1),
    case_id: z.string().min(1).max(100),
    model_route: z.enum(["subscription_cli", "fake", "metered_api", "unknown"]),
    predicted_finding_ids: z.array(z.string().min(1).max(100)).max(64),
    cost_class: z.enum(["zero_cost", "metered"]).default("zero_cost"),
    latency_ms: z.number().int().min(0).optional()
  })
  .strict();

export type EvalRun = z.infer<typeof EvalRunSchema>;

export function corpusIdentity(cases: readonly BenchmarkCase[]): string {
  return createHash("sha256").update(stableJson([...cases]), "utf8").digest("hex");
}

export function scoreRun(
  gold: BenchmarkCase,
  run: EvalRun
): {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
} {
  const expected = new Set(gold.expected_finding_ids);
  const predicted = new Set(run.predicted_finding_ids);
  let tp = 0;
  for (const id of predicted) if (expected.has(id)) tp += 1;
  const fp = predicted.size - tp;
  const fn = expected.size - tp;
  const precision = predicted.size === 0 ? 0 : tp / predicted.size;
  const recall = expected.size === 0 ? 1 : tp / expected.size;
  return { tp, fp, fn, precision, recall };
}

export function assertCiSafeRun(run: EvalRun): void {
  if (run.model_route === "metered_api" || run.model_route === "unknown") {
    throw new Error("CI eval subset must be zero-cost fake/subscription only");
  }
  if (run.cost_class !== "zero_cost") {
    throw new Error("CI eval subset must be zero_cost");
  }
}
