import { z } from "zod";
import { ResearchStewardError } from "./utils.js";

/**
 * Citation integrity gates (Task 3.6, module layer). Offline must report
 * not_checked — never interpret network failure as "no retraction".
 */

export const CITATION_GATES = [
  "existence",
  "metadata",
  "support",
  "retraction"
] as const;

export type CitationGate = (typeof CITATION_GATES)[number];

export const GateStatusSchema = z.enum([
  "pass",
  "fail",
  "not_checked",
  "candidate_only"
]);

export type GateStatus = z.infer<typeof GateStatusSchema>;

export const CitationCheckSchema = z
  .object({
    check_version: z.literal(1),
    citation_id: z.string().min(1).max(100),
    doi: z.string().max(200).optional(),
    title: z.string().max(500).optional(),
    gates: z.object({
      existence: GateStatusSchema,
      metadata: GateStatusSchema,
      support: GateStatusSchema,
      retraction: GateStatusSchema
    }),
    checked_at: z.string().datetime({ offset: true }).nullable().default(null),
    notes: z.array(z.string().max(500)).max(32).default([])
  })
  .strict();

export type CitationCheck = z.infer<typeof CitationCheckSchema>;

export function offlineCitationCheck(citation_id: string): CitationCheck {
  return CitationCheckSchema.parse({
    check_version: 1,
    citation_id,
    gates: {
      existence: "not_checked",
      metadata: "not_checked",
      support: "not_checked",
      retraction: "not_checked"
    },
    checked_at: null,
    notes: ["Offline: network-dependent gates were not run."]
  });
}

/**
 * Local-only existence/metadata candidate from a DOI string shape. Never
 * auto-rewrites a bibliography — only produces candidates.
 */
export function doiCandidate(doi: string): { ok: boolean; normalized?: string } {
  const trimmed = doi.trim().replace(/^https?:\/\/doi\.org\//i, "");
  if (!/^10\.\d{4,9}\/\S+$/.test(trimmed)) return { ok: false };
  return { ok: true, normalized: trimmed };
}

export function assertNotClaimingCleanRetraction(check: CitationCheck): void {
  if (check.gates.retraction === "not_checked" || check.gates.retraction === "candidate_only") {
    return;
  }
  // pass/fail require checked_at
  if (check.checked_at === null) {
    throw new ResearchStewardError(
      "CITATION_CHECK_INCOMPLETE",
      "retraction gate cannot be pass/fail without a checked_at timestamp."
    );
  }
}
