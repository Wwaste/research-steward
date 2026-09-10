import { z } from "zod";

/**
 * Non-chat control-plane read model (Task 5.1, module layer). UI reads only
 * these materialized views; writes go through existing governance APIs.
 */

export const ProjectRailItemSchema = z
  .object({
    project_id: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    phase: z.string().min(1).max(64),
    blocked: z.boolean(),
    open_decisions: z.number().int().min(0)
  })
  .strict();

export const DagNodeViewSchema = z
  .object({
    node_id: z.string().min(1).max(100),
    actor_id: z.string().min(1).max(100).optional(),
    model: z.string().min(1).max(100).optional(),
    route: z.enum(["subscription_cli", "metered_api", "fake", "unknown"]).optional(),
    status: z.string().min(1).max(64),
    uncertainty: z.string().max(500).optional(),
    depends_on: z.array(z.string().min(1).max(100)).max(64)
  })
  .strict();

export const AttentionItemSchema = z
  .object({
    id: z.string().min(1).max(100),
    kind: z.enum(["decision", "blocker", "verification", "delivery", "other"]),
    summary: z.string().min(1).max(500),
    digest_hash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

export const ControlPlaneReadModelSchema = z
  .object({
    read_model_version: z.literal(1),
    generated_at: z.string().datetime({ offset: true }),
    status_summary: z.string().min(1).max(500),
    rail: z.array(ProjectRailItemSchema).max(200),
    dag: z.array(DagNodeViewSchema).max(2_000),
    attention: z.array(AttentionItemSchema).max(500),
    next_decision: z.string().max(500).nullable().default(null),
    last_verification_id: z.string().max(200).nullable().default(null)
  })
  .strict();

export type ControlPlaneReadModel = z.infer<typeof ControlPlaneReadModelSchema>;

export function emptyReadModel(generatedAt: string): ControlPlaneReadModel {
  return ControlPlaneReadModelSchema.parse({
    read_model_version: 1,
    generated_at: generatedAt,
    status_summary: "No projects loaded.",
    rail: [],
    dag: [],
    attention: [],
    next_decision: null,
    last_verification_id: null
  });
}

/** First-screen budget: must answer status, blockers, next decision, verification. */
export function summarizeForFirstScreen(model: ControlPlaneReadModel): {
  status: string;
  blocked_count: number;
  next_decision: string | null;
  last_verification_id: string | null;
} {
  return {
    status: model.status_summary,
    blocked_count: model.rail.filter((item) => item.blocked).length,
    next_decision: model.next_decision,
    last_verification_id: model.last_verification_id
  };
}

export function filterAttention(
  model: ControlPlaneReadModel,
  kinds: readonly Array<"decision" | "blocker" | "verification" | "delivery" | "other">
): ControlPlaneReadModel["attention"] {
  const set = new Set(kinds);
  return model.attention.filter((item) => set.has(item.kind));
}
