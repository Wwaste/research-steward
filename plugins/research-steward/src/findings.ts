import { createHash } from "node:crypto";
import { z } from "zod";
import { ResearchStewardError, stableJson } from "./utils.js";

/**
 * Diff-based re-review and finding lifecycle (Task 2.6, module layer).
 * `fixed` requires remediation evidence — never an author's "I fixed it".
 */

export const FINDING_STATES = [
  "open",
  "fixed",
  "accepted_risk",
  "obsolete",
  "deferred"
] as const;

export type FindingState = (typeof FINDING_STATES)[number];

export const FindingSchema = z
  .object({
    finding_id: z.string().min(1).max(100),
    state: z.enum(FINDING_STATES),
    severity: z.enum(["minor", "important", "critical"]),
    title: z.string().min(1).max(500),
    locator: z.string().min(1).max(500).optional(),
    packet_id: z.string().min(1).max(100),
    remediation_evidence: z.string().max(2_000).nullable().default(null),
    adjudicator: z.string().min(1).max(100).nullable().default(null),
    updated_at: z.string().datetime({ offset: true })
  })
  .strict();

export type Finding = z.infer<typeof FindingSchema>;

export const DiffPacketSchema = z
  .object({
    diff_version: z.literal(1),
    base_packet_id: z.string().min(1).max(100),
    base_packet_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    target_packet_id: z.string().min(1).max(100),
    target_packet_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    changed_files: z.array(z.string().min(1).max(4_096)).max(500),
    created_at: z.string().datetime({ offset: true })
  })
  .strict();

export type DiffPacket = z.infer<typeof DiffPacketSchema>;

export function diffPacketHash(packet: DiffPacket): string {
  return createHash("sha256").update(stableJson(packet), "utf8").digest("hex");
}

const ALLOWED: Record<FindingState, readonly FindingState[]> = {
  open: ["fixed", "accepted_risk", "obsolete", "deferred"],
  fixed: ["open", "obsolete"],
  accepted_risk: ["open"],
  obsolete: [],
  deferred: ["open"]
};

export function transitionFinding(
  finding: Finding,
  next: FindingState,
  input: {
    adjudicator?: string;
    remediation_evidence?: string;
    now?: string;
  }
): Finding {
  if (!ALLOWED[finding.state].includes(next)) {
    throw new ResearchStewardError(
      "FINDING_INVALID_TRANSITION",
      `Cannot move finding from ${finding.state} to ${next}.`,
      { from: finding.state, to: next }
    );
  }
  if (next === "fixed") {
    if (
      input.remediation_evidence === undefined ||
      input.remediation_evidence.trim() === ""
    ) {
      throw new ResearchStewardError(
        "FINDING_FIXED_REQUIRES_EVIDENCE",
        "A finding may only be marked fixed with remediation evidence (command, commit, or packet)."
      );
    }
  }
  if (
    (next === "accepted_risk" || next === "fixed") &&
    (input.adjudicator === undefined || input.adjudicator.trim() === "")
  ) {
    throw new ResearchStewardError(
      "FINDING_ADJUDICATOR_REQUIRED",
      "Authoritative disposition requires a named adjudicator."
    );
  }
  return FindingSchema.parse({
    ...finding,
    state: next,
    remediation_evidence:
      input.remediation_evidence ?? finding.remediation_evidence,
    adjudicator: input.adjudicator ?? finding.adjudicator,
    updated_at: input.now ?? new Date().toISOString()
  });
}

export function openFinding(input: {
  finding_id: string;
  severity: Finding["severity"];
  title: string;
  packet_id: string;
  locator?: string;
  now?: string;
}): Finding {
  return FindingSchema.parse({
    finding_id: input.finding_id,
    state: "open",
    severity: input.severity,
    title: input.title,
    packet_id: input.packet_id,
    ...(input.locator === undefined ? {} : { locator: input.locator }),
    remediation_evidence: null,
    adjudicator: null,
    updated_at: input.now ?? new Date().toISOString()
  });
}
