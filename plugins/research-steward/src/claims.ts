import { z } from "zod";
import { EvidenceLocatorSchema } from "./evidence.js";
import { ResearchStewardError } from "./utils.js";

/**
 * Claim–Evidence matrix and lineage (Task 3.5, module layer). Protocol event
 * wiring stays with the integrator.
 */

export const CLAIM_TYPES = [
  "descriptive",
  "associational",
  "causal",
  "predictive",
  "mechanistic",
  "methodological"
] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];

export const ClaimSchema = z
  .object({
    claim_id: z.string().min(1).max(100),
    type: z.enum(CLAIM_TYPES),
    text: z.string().min(1).max(4_000),
    /** Who authored the claim text (role id, never a secret). */
    author: z.string().min(1).max(100),
    created_at: z.string().datetime({ offset: true })
  })
  .strict();

export type Claim = z.infer<typeof ClaimSchema>;

export const SUPPORT_RELATIONS = [
  "supports",
  "weakens",
  "contradicts",
  "empty"
] as const;

export type SupportRelation = (typeof SUPPORT_RELATIONS)[number];

export const ClaimEvidenceLinkSchema = z
  .object({
    claim_id: z.string().min(1).max(100),
    relation: z.enum(SUPPORT_RELATIONS),
    evidence: EvidenceLocatorSchema,
    /** Strength is never auto-promoted by majority of models. */
    strength: z.enum(["weak", "moderate", "strong"]),
    note: z.string().max(2_000).optional()
  })
  .strict();

export type ClaimEvidenceLink = z.infer<typeof ClaimEvidenceLinkSchema>;

export const LINEAGE_NODE_KINDS = [
  "source",
  "transform",
  "analysis",
  "table",
  "figure",
  "manuscript_claim"
] as const;

export const LineageNodeSchema = z
  .object({
    node_id: z.string().min(1).max(100),
    kind: z.enum(LINEAGE_NODE_KINDS),
    label: z.string().min(1).max(500),
    identity: z.string().min(1).max(500),
    depends_on: z.array(z.string().min(1).max(100)).max(64).default([])
  })
  .strict();

export type LineageNode = z.infer<typeof LineageNodeSchema>;

export const ClaimMatrixSchema = z
  .object({
    matrix_version: z.literal(1),
    claims: z.array(ClaimSchema).max(500),
    links: z.array(ClaimEvidenceLinkSchema).max(2_000),
    lineage: z.array(LineageNodeSchema).max(2_000)
  })
  .strict();

export type ClaimMatrix = z.infer<typeof ClaimMatrixSchema>;

export function emptyClaimMatrix(): ClaimMatrix {
  return { matrix_version: 1, claims: [], links: [], lineage: [] };
}

export function parseClaimMatrix(raw: unknown): ClaimMatrix {
  return ClaimMatrixSchema.parse(raw);
}

export function upsertClaim(matrix: ClaimMatrix, claim: Claim): ClaimMatrix {
  ClaimSchema.parse(claim);
  const claims = matrix.claims.filter((entry) => entry.claim_id !== claim.claim_id);
  claims.push(claim);
  return { ...matrix, claims };
}

export function addEvidenceLink(
  matrix: ClaimMatrix,
  link: ClaimEvidenceLink
): ClaimMatrix {
  ClaimEvidenceLinkSchema.parse(link);
  if (!matrix.claims.some((claim) => claim.claim_id === link.claim_id)) {
    throw new ResearchStewardError(
      "CLAIM_NOT_FOUND",
      `No claim with id "${link.claim_id}" exists in this matrix.`,
      { claim_id: link.claim_id }
    );
  }
  return { ...matrix, links: [...matrix.links, link] };
}

export function upsertLineageNode(
  matrix: ClaimMatrix,
  node: LineageNode
): ClaimMatrix {
  LineageNodeSchema.parse(node);
  for (const dep of node.depends_on) {
    if (!matrix.lineage.some((existing) => existing.node_id === dep) && dep !== node.node_id) {
      // Allow forward refs only if present; otherwise reject.
      throw new ResearchStewardError(
        "LINEAGE_DEPENDENCY_MISSING",
        `Lineage node "${node.node_id}" depends on unknown node "${dep}".`,
        { node_id: node.node_id, missing: dep }
      );
    }
  }
  const lineage = matrix.lineage.filter((entry) => entry.node_id !== node.node_id);
  lineage.push(node);
  return { ...matrix, lineage };
}

/**
 * Mark claims whose upstream lineage identity changed as stale. Does not
 * auto-judge them false — only flags review (Task 3.5 checkbox).
 */
export function markStaleForSourceChange(
  matrix: ClaimMatrix,
  changedNodeIds: readonly string[]
): { stale_claim_ids: string[] } {
  const changed = new Set(changedNodeIds);
  const reachable = new Set<string>(changed);
  // Fixed-point over depends_on edges (reverse: who depends on changed).
  for (let i = 0; i < matrix.lineage.length + 1; i += 1) {
    for (const node of matrix.lineage) {
      if (node.depends_on.some((dep) => reachable.has(dep))) {
        reachable.add(node.node_id);
      }
    }
  }
  const stale = matrix.claims
    .filter((claim) =>
      matrix.lineage.some(
        (node) => node.kind === "manuscript_claim" && reachable.has(node.node_id) &&
          (node.identity.includes(claim.claim_id) || node.label.includes(claim.claim_id))
      ) || reachable.has(claim.claim_id)
    )
    .map((claim) => claim.claim_id);
  return { stale_claim_ids: [...new Set(stale)].sort() };
}

export function coverageMap(matrix: ClaimMatrix): Array<{
  claim_id: string;
  supports: number;
  weakens: number;
  contradicts: number;
  empty: number;
  uncovered: boolean;
}> {
  return matrix.claims.map((claim) => {
    const links = matrix.links.filter((link) => link.claim_id === claim.claim_id);
    const count = (relation: SupportRelation): number =>
      links.filter((link) => link.relation === relation).length;
    const supports = count("supports");
    const weakens = count("weakens");
    const contradicts = count("contradicts");
    const empty = count("empty");
    return {
      claim_id: claim.claim_id,
      supports,
      weakens,
      contradicts,
      empty,
      uncovered: supports === 0 && weakens === 0 && contradicts === 0
    };
  });
}

/**
 * Causal claims cannot rest on weak evidence alone.
 */
export function assertCausalSupport(matrix: ClaimMatrix): void {
  for (const claim of matrix.claims) {
    if (claim.type !== "causal") continue;
    const supports = matrix.links.filter(
      (link) => link.claim_id === claim.claim_id && link.relation === "supports"
    );
    if (supports.length > 0 && supports.every((link) => link.strength === "weak")) {
      throw new ResearchStewardError(
        "CAUSAL_CLAIM_UNDER_SUPPORTED",
        `Causal claim "${claim.claim_id}" is supported only by weak evidence.`,
        { claim_id: claim.claim_id }
      );
    }
  }
}
