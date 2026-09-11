import { z } from "zod";

/**
 * Gate evidence shapes (DESIGN-PHASE2-GATE). All artifacts are deletable
 * caches — not authoritative ledger writes.
 */

export const GateSampleSchema = z
  .object({
    scenario_id: z.string().min(1).max(32),
    counter_value: z.number().int().min(0),
    ledger_head_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    event_count: z.number().int().min(0),
    window_class: z.enum(["W1", "W2", "W3"]).optional(),
    captured_at: z.string().datetime({ offset: true }),
    notes: z.string().max(500).optional()
  })
  .strict();

export type GateSample = z.infer<typeof GateSampleSchema>;

export const GateScenarioResultSchema = z
  .object({
    scenario_id: z.string().min(1).max(32),
    samples: z.array(GateSampleSchema).max(200),
    verdict: z.enum(["reported_pass", "failed"]),
    failure_code: z.string().max(100).optional()
  })
  .strict();

export type GateScenarioResult = z.infer<typeof GateScenarioResultSchema>;

export const GateReportSchema = z
  .object({
    report_version: z.literal(1),
    generated_at: z.string().datetime({ offset: true }),
    /** Always reported_pass — the authoritative gate verdict is external. */
    status: z.enum(["reported_pass", "failed"]),
    scenarios: z.array(GateScenarioResultSchema).max(32),
    relative_budgets: z
      .array(
        z
          .object({
            metric: z.string().min(1).max(100),
            ratio: z.number().min(0),
            budget: z.number().min(0),
            environment_noisy: z.boolean()
          })
          .strict()
      )
      .max(32)
      .default([])
  })
  .strict();

export type GateReport = z.infer<typeof GateReportSchema>;
