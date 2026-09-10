import { z } from "zod";
import { ResearchStewardError } from "./utils.js";

/**
 * Delivery state machine (Task 5.4, module layer). Upload connectors stay
 * unauthorized until individually approved; this module only tracks states
 * and byte receipts.
 */

export const DELIVERY_STATES = [
  "candidate_declared",
  "delivery_authorized",
  "delivery_recorded",
  "delivery_verified"
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const DeliveryReceiptSchema = z
  .object({
    destination: z.string().min(1).max(500),
    object_id: z.string().min(1).max(500),
    version: z.string().min(1).max(200).optional(),
    size_bytes: z.number().int().min(0),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    recorded_at: z.string().datetime({ offset: true })
  })
  .strict();

export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;

export const DeliveryRecordSchema = z
  .object({
    delivery_version: z.literal(1),
    package_id: z.string().min(1).max(100),
    state: z.enum(DELIVERY_STATES),
    idempotency_key: z.string().min(1).max(200),
    local_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    receipt: DeliveryReceiptSchema.nullable().default(null)
  })
  .strict();

export type DeliveryRecord = z.infer<typeof DeliveryRecordSchema>;

const TRANSITIONS: Record<DeliveryState, readonly DeliveryState[]> = {
  candidate_declared: ["delivery_authorized"],
  delivery_authorized: ["delivery_recorded"],
  delivery_recorded: ["delivery_verified"],
  delivery_verified: []
};

export function declareCandidate(input: {
  package_id: string;
  idempotency_key: string;
  local_sha256: string;
}): DeliveryRecord {
  return DeliveryRecordSchema.parse({
    delivery_version: 1,
    package_id: input.package_id,
    state: "candidate_declared",
    idempotency_key: input.idempotency_key,
    local_sha256: input.local_sha256,
    receipt: null
  });
}

export function transitionDelivery(
  record: DeliveryRecord,
  next: DeliveryState,
  receipt?: DeliveryReceipt
): DeliveryRecord {
  if (!TRANSITIONS[record.state].includes(next)) {
    throw new ResearchStewardError(
      "DELIVERY_INVALID_TRANSITION",
      `Cannot move delivery from ${record.state} to ${next}.`,
      { from: record.state, to: next }
    );
  }
  if (next === "delivery_recorded") {
    if (receipt === undefined) {
      throw new ResearchStewardError(
        "DELIVERY_RECEIPT_REQUIRED",
        "delivery_recorded requires a byte receipt."
      );
    }
    if (receipt.sha256 !== record.local_sha256) {
      throw new ResearchStewardError(
        "DELIVERY_HASH_MISMATCH",
        "Remote receipt hash does not match the local package hash.",
        { local: record.local_sha256, remote: receipt.sha256 }
      );
    }
  }
  if (next === "delivery_verified") {
    if (record.receipt === null && receipt === undefined) {
      throw new ResearchStewardError(
        "DELIVERY_NOT_VERIFIABLE",
        "Cannot verify without a recorded receipt."
      );
    }
  }
  return DeliveryRecordSchema.parse({
    ...record,
    state: next,
    receipt: receipt ?? record.receipt
  });
}

/** Repeat upload with same idempotency key must not double-record. */
export function assertIdempotentRepeat(
  existing: DeliveryRecord,
  incomingKey: string
): void {
  if (existing.idempotency_key !== incomingKey) {
    throw new ResearchStewardError(
      "DELIVERY_IDEMPOTENCY_MISMATCH",
      "A different idempotency key was used for this package.",
      { existing: existing.idempotency_key }
    );
  }
}
