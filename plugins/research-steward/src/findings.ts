import { z } from "zod";
import { IdentifierSchema, type CommittedEvent } from "./protocol.js";
import { ResearchStewardError } from "./utils.js";

/**
 * Finding lifecycle as a fold over the ledger (DESIGN-EVIDENCE §3).
 * Module-layer only — finding_transition event types land with protocol ①.
 */

export const FINDING_FOLD_STATES = [
  "reported",
  "open",
  "fixed",
  "accepted_risk",
  "rejected",
  "deferred",
  "obsolete"
] as const;

export type FindingFoldState = (typeof FINDING_FOLD_STATES)[number];

export const FindingSnapshotSchema = z
  .object({
    finding_event_id: z.string().uuid(),
    finding_id: IdentifierSchema,
    reporter_actor_id: IdentifierSchema,
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    claim: z.string().min(1),
    state: z.enum(FINDING_FOLD_STATES),
    adjudicator_actor_id: IdentifierSchema.nullable().default(null),
    remediation_evidence_fingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/)).default([]),
    fixed_in_packet_id: z.string().nullable().default(null),
    expires_at: z.string().datetime({ offset: true }).nullable().default(null),
    last_transition_event_id: z.string().uuid().nullable().default(null),
    open_diff_review_id: z.string().nullable().default(null),
    /** CR-M-066: first structured locator for carry-forward decisions. */
    locator_path: z.string().max(4_096).nullable().default(null)
  })
  .strict();

export type FindingSnapshot = z.infer<typeof FindingSnapshotSchema>;

const ALLOWED: Record<FindingFoldState, readonly FindingFoldState[]> = {
  reported: ["open", "rejected", "deferred"],
  open: ["fixed", "accepted_risk", "obsolete", "deferred", "open"],
  fixed: ["open", "obsolete"],
  accepted_risk: ["open"],
  rejected: [],
  deferred: ["open"],
  obsolete: []
};

export function isLegalFindingTransition(from: FindingFoldState, to: FindingFoldState): boolean {
  return ALLOWED[from].includes(to);
}

function key(findingEventId: string, findingId: string): string {
  return `${findingEventId}:${findingId}`;
}

/**
 * Fold agent/adjudication findings plus finding_transition events into
 * snapshots. Illegal orders are ignored here and rejected at append time.
 */
export function foldFindings(events: readonly CommittedEvent[]): Map<string, FindingSnapshot> {
  const map = new Map<string, FindingSnapshot>();
  for (const event of events) {
    if (event.type === "agent_contribution" || event.type === "adjudication") {
      const findings = Array.isArray(event.findings) ? event.findings : [];
      for (const finding of findings) {
        if (finding === null || typeof finding !== "object") continue;
        const f = finding as { id?: unknown; severity?: unknown; claim?: unknown };
        if (typeof f.id !== "string") continue;
        const k = key(event.event_id, f.id);
        if (map.has(k)) continue;
        const evidenceList = Array.isArray((finding as { evidence?: unknown }).evidence)
          ? ((finding as { evidence: unknown[] }).evidence)
          : [];
        const structured = evidenceList.find(
          (e) =>
            e !== null &&
            typeof e === "object" &&
            (e as { kind?: unknown }).kind === "structured"
        ) as unknown as { locator?: { path?: string } } | undefined;
        // CR-M-066: if this event is an adjudication, fold accept/partial → open
        const decisions = Array.isArray(event.decisions) ? event.decisions : [];
        const matching = decisions.find(
          (d) =>
            d !== null &&
            typeof d === "object" &&
            (d as { finding_id?: unknown }).finding_id === f.id
        ) as { disposition?: string } | undefined;
        const initState =
          event.type === "adjudication" && matching?.disposition === "accept"
            ? "open"
            : event.type === "adjudication" && matching?.disposition === "reject"
              ? "rejected"
              : event.type === "adjudication" && matching?.disposition === "defer"
                ? "deferred"
                : "reported";
        map.set(
          k,
          FindingSnapshotSchema.parse({
            finding_event_id: event.event_id,
            finding_id: f.id,
            reporter_actor_id: event.actor.id,
            severity: f.severity ?? "info",
            claim: typeof f.claim === "string" ? f.claim : "",
            state: initState,
            locator_path:
              structured?.locator?.path ??
              typeof (finding as { locator?: unknown }).locator === "string"
                ? (finding as unknown as { locator: string }).locator
                : null
          })
        );
      }
    }
    if ((event.type as string) === "finding_transition") {
      const meta = event.metadata as Record<string, unknown>;
      const findingEventId = meta["finding_event_id"];
      const findingId = meta["finding_id"];
      const to = meta["to"];
      if (
        typeof findingEventId !== "string" ||
        typeof findingId !== "string" ||
        typeof to !== "string"
      ) {
        continue;
      }
      const k = key(findingEventId, findingId);
      const existing = map.get(k);
      if (!existing) continue;
      if (!isLegalFindingTransition(existing.state, to as FindingFoldState)) continue;
      const reopen = to === "open" && existing.state !== "reported";
      const reconfirm = to === "open" && existing.state === "open";
      map.set(k, {
        ...existing,
        state: to as FindingFoldState,
        // CR-M-066: reopen from terminal clears authority; open→open reconfirm keeps it.
        adjudicator_actor_id: reconfirm
          ? existing.adjudicator_actor_id
          : reopen
            ? null
            : event.actor.id,
        remediation_evidence_fingerprints: reopen
          ? []
          : Array.isArray(meta["remediation_evidence_fingerprints"])
            ? (meta["remediation_evidence_fingerprints"] as string[])
            : existing.remediation_evidence_fingerprints,
        fixed_in_packet_id: reopen
          ? null
          : typeof meta["fixed_in_packet_id"] === "string"
            ? (meta["fixed_in_packet_id"] as string)
            : existing.fixed_in_packet_id,
        expires_at: reopen
          ? null
          : typeof meta["expires_at"] === "string"
            ? (meta["expires_at"] as string)
            : existing.expires_at,
        last_transition_event_id: event.event_id,
        open_diff_review_id:
          typeof meta["diff_review_id"] === "string"
            ? (meta["diff_review_id"] as string)
            : to === "open"
              ? existing.open_diff_review_id
              : null
      });
    }
  }
  return map;
}

export function assertSelfAdjudication(
  snapshot: FindingSnapshot,
  adjudicatorActorId: string
): void {
  if (snapshot.reporter_actor_id === adjudicatorActorId) {
    throw new ResearchStewardError(
      "SELF_ADJUDICATION",
      "A reporter cannot authoritatively adjudicate their own finding.",
      { finding_id: snapshot.finding_id }
    );
  }
}

export function assertFixedRequiresEvidence(snapshot: FindingSnapshot): void {
  if (snapshot.state === "fixed") {
    if (
      snapshot.remediation_evidence_fingerprints.length === 0 ||
      snapshot.fixed_in_packet_id === null
    ) {
      throw new ResearchStewardError(
        "FINDING_FIXED_REQUIRES_EVIDENCE",
        "fixed requires remediation evidence fingerprints and a frozen packet id."
      );
    }
  }
  if (snapshot.state === "accepted_risk" && snapshot.expires_at === null) {
    throw new ResearchStewardError(
      "FINDING_ACCEPTED_RISK_REQUIRES_EXPIRY",
      "accepted_risk requires expires_at."
    );
  }
}
