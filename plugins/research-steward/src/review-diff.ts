import { createHash } from "node:crypto";
import { z } from "zod";
import { stableJson } from "./utils.js";

/**
 * Diff packet + roster (DESIGN-EVIDENCE §4, module layer).
 * Diff packets are frozen attachments under .research/diffs/, not inline
 * event payloads. Matching is advisory only.
 */

export const ChangedFileSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    status: z.enum(["added", "modified", "deleted", "renamed"]),
    previous_path: z.string().min(1).max(4_096).optional(),
    old_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    new_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
  })
  .strict();

export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const DiffPacketSchema = z
  .object({
    diff_version: z.literal(2),
    diff_review_id: z.string().min(1).max(100),
    base_packet_id: z.string().min(1).max(100),
    base_packet_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    target_packet_id: z.string().min(1).max(100),
    target_packet_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    changed_files: z.array(ChangedFileSchema).max(2_000),
    created_at: z.string().datetime({ offset: true })
  })
  .strict();

export type DiffPacketV2 = z.infer<typeof DiffPacketSchema>;

export function diffPacketHash(packet: DiffPacketV2): string {
  return createHash("sha256").update(stableJson(packet), "utf8").digest("hex");
}

/** Advisory: can this finding locator be carried forward? Never authoritative. */
export function locatorTouchesChangedFile(
  locatorPath: string | undefined,
  changed: readonly ChangedFile[]
): boolean {
  if (locatorPath === undefined) return false;
  return changed.some(
    (file) =>
      file.path === locatorPath ||
      (file.previous_path !== undefined && file.previous_path === locatorPath)
  );
}
