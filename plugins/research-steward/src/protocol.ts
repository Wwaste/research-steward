import { z } from "zod";

export const PROTOCOL_VERSION = "1.0" as const;
export const MAX_EVENT_BYTES = 256_000;
export const MAX_PATH_LENGTH = 4_096;

const IdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ProjectManifestSchema = z
  .object({
    protocol_version: z.literal(PROTOCOL_VERSION),
    project_id: z.string().uuid(),
    title: z.string().min(1).max(200),
    created_at: z.string().datetime({ offset: true })
  })
  .strict();

export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

export const ActorSchema = z
  .object({
    id: IdentifierSchema,
    role: z.string().min(1).max(100),
    adapter: z.string().min(1).max(50).optional(),
    model: z.string().min(1).max(100).optional()
  })
  .strict();

export type Actor = z.infer<typeof ActorSchema>;

export const EvidenceSchema = z
  .object({
    locator: z.string().min(1).max(2_000),
    kind: z.enum(["source", "artifact", "command", "observation", "other"]),
    note: z.string().max(4_000).optional()
  })
  .strict();

export const FindingSchema = z
  .object({
    id: IdentifierSchema,
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    claim: z.string().min(1).max(20_000),
    evidence: z.array(EvidenceSchema).max(50).default([]),
    uncertainty: z.string().max(4_000).default(""),
    remediation: z.string().max(10_000).default("")
  })
  .strict();

export const DecisionSchema = z
  .object({
    finding_id: IdentifierSchema,
    disposition: z.enum(["accept", "partial", "reject", "defer"]),
    rationale: z.string().min(1).max(20_000),
    action: z.string().max(10_000).default(""),
    owner: z.string().max(100).default(""),
    change_evidence: z.string().max(10_000).default("")
  })
  .strict();

export const EventTypeSchema = z.enum([
  "project_initialized",
  "candidate_declared",
  "packet_frozen",
  "run_started",
  "agent_contribution",
  "review_barrier_closed",
  "adjudication",
  "verification",
  "provisional_review",
  "acceptance",
  "package_created",
  "delivery_recorded",
  "delivery_verified",
  "block_resolved",
  "blocked"
]);

export const EventDraftSchema = z
  .object({
    type: EventTypeSchema,
    run_id: IdentifierSchema.optional(),
    actor: ActorSchema,
    input_hash: HashSchema.optional(),
    depends_on: z.array(z.string().uuid()).max(512).default([]),
    visibility: z.enum(["shared", "blind", "private"]).default("shared"),
    status: z.enum(["complete", "blocked", "failed"]).default("complete"),
    summary: z.string().max(100_000).default(""),
    uncertainties: z.array(z.string().max(2_000)).max(100).default([]),
    evidence: z.array(EvidenceSchema).max(200).default([]),
    findings: z.array(FindingSchema).max(200).default([]),
    decisions: z.array(DecisionSchema).max(200).default([]),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export type EventDraft = z.input<typeof EventDraftSchema>;

export const CommittedEventSchema = EventDraftSchema.extend({
  protocol_version: z.literal(PROTOCOL_VERSION),
  event_id: z.string().uuid(),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime({ offset: true }),
  project_id: z.string().uuid(),
  previous_event_hash: HashSchema.nullable(),
  event_hash: HashSchema
}).strict();

export type CommittedEvent = z.infer<typeof CommittedEventSchema>;

export const PacketFileSchema = z
  .object({
    path: z.string().min(1).max(MAX_PATH_LENGTH),
    size: z.number().int().nonnegative(),
    sha256: HashSchema
  })
  .strict();

export const FrozenPacketSchema = z
  .object({
    protocol_version: z.literal(PROTOCOL_VERSION),
    packet_id: IdentifierSchema.regex(/^[a-z0-9][a-z0-9-]*$/),
    project_id: z.string().uuid(),
    created_at: z.string().datetime({ offset: true }),
    files: z.array(PacketFileSchema).min(1).max(500),
    packet_hash: HashSchema
  })
  .strict();

export type FrozenPacket = z.infer<typeof FrozenPacketSchema>;

export const RoundtableNodeSchema = z
  .object({
    id: IdentifierSchema,
    actor_id: IdentifierSchema,
    role: z.string().min(1).max(100),
    adapter: z.enum(["kimi", "qoder", "grok", "fake"]),
    model: z.string().min(1).max(100).optional(),
    brief: z.string().min(1).max(20_000),
    depends_on: z.array(IdentifierSchema).max(16).default([]),
    visibility: z.enum(["shared", "blind", "private"]).default("shared"),
    blind_group: IdentifierSchema.optional(),
    can_adjudicate: z.boolean().default(false),
    timeout_ms: z.number().int().min(1_000).max(1_800_000).default(300_000)
  })
  .strict();

export const RoundtablePlanSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(200),
    packet_id: IdentifierSchema.regex(/^[a-z0-9][a-z0-9-]*$/),
    mode: z.enum(["open", "blind", "mixed"]),
    limits: z
      .object({
        max_parallel: z.number().int().min(1).max(8).default(3),
        max_wall_time_ms: z
          .number()
          .int()
          .min(1_000)
          .max(7_200_000)
          .default(1_800_000),
        max_prompt_chars: z.number().int().min(1_000).max(500_000).default(120_000),
        max_output_chars: z.number().int().min(1_000).max(200_000).default(60_000),
        retry_limit: z.number().int().min(0).max(2).default(1),
        max_failures: z.number().int().min(0).max(32).default(3)
      })
      .strict(),
    nodes: z.array(RoundtableNodeSchema).min(1).max(32)
  })
  .strict();

export type RoundtablePlan = z.infer<typeof RoundtablePlanSchema>;
export type RoundtableNode = z.infer<typeof RoundtableNodeSchema>;

export const ModelOutputSchema = z
  .object({
    status: z.enum(["complete", "blocked"]),
    summary: z.string().min(1).max(100_000),
    uncertainties: z.array(z.string().max(2_000)).max(100).default([]),
    evidence: z.array(EvidenceSchema).max(200).default([]),
    findings: z.array(FindingSchema).max(200).default([]),
    decisions: z.array(DecisionSchema).max(200).default([])
  })
  .strict();

export type ModelOutput = z.infer<typeof ModelOutputSchema>;

export interface VerificationCheck {
  id: string;
  status: "pass" | "fail" | "blocked" | "not_applicable";
  message: string;
}

export interface VerificationReport {
  project_id: string;
  checked_at: string;
  passed: boolean;
  checks: VerificationCheck[];
  verification_event_id: string;
  verification_event_hash: string;
}
