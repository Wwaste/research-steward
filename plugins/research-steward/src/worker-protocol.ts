import { createHash } from "node:crypto";
import { z } from "zod";
import { ResearchStewardError, stableJson } from "./utils.js";

/**
 * Coordinator–worker protocol types (Task 4.1, module freeze). Fake workers
 * only in this phase; no VPS/HPC side effects.
 */

export const JobLeaseSchema = z
  .object({
    lease_version: z.literal(1),
    job_id: z.string().min(1).max(100),
    worker_id: z.string().min(1).max(100),
    attempt: z.number().int().min(1),
    acquired_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
    idempotency_key: z.string().min(1).max(200),
    input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    confidentiality: z.enum(["public", "internal", "restricted"])
  })
  .strict();

export type JobLease = z.infer<typeof JobLeaseSchema>;

export const WorkerCapabilitySchema = z
  .object({
    worker_id: z.string().min(1).max(100),
    adapters: z.array(z.string().min(1).max(64)).max(32),
    skills: z.array(z.string().min(1).max(64)).max(64),
    max_concurrency: z.number().int().min(1).max(32),
    confidentiality: z.enum(["public", "internal", "restricted"])
  })
  .strict();

export type WorkerCapability = z.infer<typeof WorkerCapabilitySchema>;

export const JobResultSchema = z
  .object({
    result_version: z.literal(1),
    job_id: z.string().min(1).max(100),
    attempt: z.number().int().min(1),
    worker_id: z.string().min(1).max(100),
    status: z.enum(["succeeded", "failed", "cancelled"]),
    output_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    finished_at: z.string().datetime({ offset: true }),
    /** Late results are kept as evidence even if not selected for downstream. */
    accepted_for_downstream: z.boolean()
  })
  .strict();

export type JobResult = z.infer<typeof JobResultSchema>;

export function contentAddressedInput(input: unknown): string {
  return createHash("sha256").update(stableJson(input), "utf8").digest("hex");
}

export function idempotencyKey(
  job_id: string,
  input_sha256: string,
  attempt: number
): string {
  return createHash("sha256")
    .update(`${job_id}|${input_sha256}|${attempt}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * Capability/confidentiality mismatch must refuse assignment — never
 * silently downgrade (Task 4.1).
 */
export function assertAssignable(
  capability: WorkerCapability,
  required: {
    adapter?: string;
    skill?: string;
    confidentiality: "public" | "internal" | "restricted";
  }
): void {
  if (required.adapter !== undefined && !capability.adapters.includes(required.adapter)) {
    throw new ResearchStewardError(
      "WORKER_CAPABILITY_MISMATCH",
      `Worker lacks adapter "${required.adapter}".`,
      { worker_id: capability.worker_id, adapter: required.adapter }
    );
  }
  if (required.skill !== undefined && !capability.skills.includes(required.skill)) {
    throw new ResearchStewardError(
      "WORKER_CAPABILITY_MISMATCH",
      `Worker lacks skill "${required.skill}".`,
      { worker_id: capability.worker_id, skill: required.skill }
    );
  }
  const rank = { public: 0, internal: 1, restricted: 2 } as const;
  if (rank[capability.confidentiality] < rank[required.confidentiality]) {
    throw new ResearchStewardError(
      "WORKER_CONFIDENTIALITY_MISMATCH",
      "Worker confidentiality level is below the job requirement; refusing assignment.",
      { worker_id: capability.worker_id, required: required.confidentiality }
    );
  }
}

/** Only one result per job enters downstream; later attempts stay as evidence. */
export function selectDownstreamResult(
  results: readonly JobResult[]
): JobResult | undefined {
  const succeeded = results
    .filter((result) => result.status === "succeeded")
    .sort((a, b) => a.attempt - b.attempt);
  if (succeeded.length === 0) return undefined;
  const chosen = succeeded[0]!;
  return { ...chosen, accepted_for_downstream: true };
}

export function isLeaseExpired(lease: JobLease, now: Date = new Date()): boolean {
  return Date.parse(lease.expires_at) <= now.getTime();
}
