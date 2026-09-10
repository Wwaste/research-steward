import { createHash } from "node:crypto";
import { z } from "zod";
import { ResearchStewardError } from "./utils.js";

/**
 * Idempotent invocations and crash-recovery markers (Task 2.2, module layer).
 * Wired into workflow/providers only after the freeze lifts.
 */

export const INVOCATION_STATES = [
  "started",
  "finished",
  "unknown",
  "cancel_requested",
  "cancelled"
] as const;

export type InvocationState = (typeof INVOCATION_STATES)[number];

export const InvocationRecordSchema = z
  .object({
    invocation_version: z.literal(1),
    invocation_id: z.string().min(1).max(100),
    run_id: z.string().min(1).max(100),
    node_id: z.string().min(1).max(100),
    attempt: z.number().int().min(1),
    state: z.enum(INVOCATION_STATES),
    provider: z.string().min(1).max(64),
    started_at: z.string().datetime({ offset: true }),
    finished_at: z.string().datetime({ offset: true }).nullable().default(null),
    failure_class: z
      .enum([
        "quota",
        "auth",
        "model_not_found",
        "timeout",
        "transport",
        "invalid_output",
        "cancelled",
        "unknown"
      ])
      .nullable()
      .default(null),
    /** Never raw provider output — hash only. */
    stdout_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null)
  })
  .strict();

export type InvocationRecord = z.infer<typeof InvocationRecordSchema>;

export function makeInvocationId(
  run_id: string,
  node_id: string,
  attempt: number
): string {
  return createHash("sha256")
    .update(`${run_id}|${node_id}|${attempt}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function startInvocation(input: {
  run_id: string;
  node_id: string;
  attempt: number;
  provider: string;
  started_at?: string;
}): InvocationRecord {
  return InvocationRecordSchema.parse({
    invocation_version: 1,
    invocation_id: makeInvocationId(input.run_id, input.node_id, input.attempt),
    run_id: input.run_id,
    node_id: input.node_id,
    attempt: input.attempt,
    state: "started",
    provider: input.provider,
    started_at: input.started_at ?? new Date().toISOString(),
    finished_at: null,
    failure_class: null,
    stdout_sha256: null
  });
}

export function finishInvocation(
  record: InvocationRecord,
  input: {
    status: "ok" | "failed";
    failure_class?: InvocationRecord["failure_class"];
    stdout_sha256?: string;
    finished_at?: string;
  }
): InvocationRecord {
  if (record.state !== "started" && record.state !== "cancel_requested") {
    throw new ResearchStewardError(
      "INVOCATION_ALREADY_TERMINAL",
      `Invocation is already ${record.state}.`,
      { invocation_id: record.invocation_id, state: record.state }
    );
  }
  return InvocationRecordSchema.parse({
    ...record,
    state: input.status === "ok" ? "finished" : "finished",
    failure_class: input.status === "ok" ? null : (input.failure_class ?? "unknown"),
    stdout_sha256: input.stdout_sha256 ?? null,
    finished_at: input.finished_at ?? new Date().toISOString()
  });
}

export function requestCancel(record: InvocationRecord): InvocationRecord {
  if (record.state === "finished" || record.state === "cancelled") {
    throw new ResearchStewardError(
      "INVOCATION_ALREADY_TERMINAL",
      `Cannot cancel a ${record.state} invocation.`,
      { state: record.state }
    );
  }
  return InvocationRecordSchema.parse({
    ...record,
    state: "cancel_requested"
  });
}

export function confirmCancelled(
  record: InvocationRecord,
  finished_at?: string
): InvocationRecord {
  if (record.state !== "cancel_requested" && record.state !== "started") {
    throw new ResearchStewardError(
      "INVOCATION_ALREADY_TERMINAL",
      `Cannot mark ${record.state} as cancelled.`,
      { state: record.state }
    );
  }
  return InvocationRecordSchema.parse({
    ...record,
    state: "cancelled",
    failure_class: "cancelled",
    finished_at: finished_at ?? new Date().toISOString()
  });
}

/**
 * Crash recovery: a started invocation with no terminal event is unknown.
 * Default policy does not auto-replay paid calls.
 */
export function markUnknownAfterCrash(
  record: InvocationRecord
): InvocationRecord {
  if (record.state !== "started") return record;
  return InvocationRecordSchema.parse({ ...record, state: "unknown" });
}

export function allowsAutoReplay(
  record: InvocationRecord,
  opts: { resume_policy: "never" | "fake_only" | "explicit" }
): boolean {
  if (record.state !== "unknown") return false;
  if (opts.resume_policy === "never") return false;
  if (opts.resume_policy === "fake_only") return record.provider === "fake";
  return false; // explicit requires a new human-authorized resume event
}
