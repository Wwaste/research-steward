import { createHash } from "node:crypto";
import { z } from "zod";
import { stableJson } from "./utils.js";
import { EvidenceLocatorSchema } from "./evidence.js";

/**
 * Diff packet + roster + locator classification (DESIGN-EVIDENCE §4,
 * module layer). Diff packets are frozen attachments; matching is advisory.
 */

export const ChangedFileSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    status: z.enum(["added", "modified", "deleted", "renamed"]),
    previous_path: z.string().min(1).max(4_096).optional(),
    base_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    target_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
  })
  .strict();

export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const DiffPacketSchema = z
  .object({
    diff_version: z.literal(1),
    diff_review_id: z.string().uuid(),
    base_packet_id: z.string().min(1).max(100),
    base_packet_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    target_packet_id: z.string().min(1).max(100),
    target_packet_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    changed_files: z.array(ChangedFileSchema).max(1_000),
    roster: z
      .array(
        z
          .object({
            finding_event_id: z.string().uuid(),
            finding_id: z.string().min(1).max(64)
          })
          .strict()
      )
      .max(2_000),
    created_at: z.string().datetime({ offset: true })
  })
  .strict();

export type DiffPacket = z.infer<typeof DiffPacketSchema>;

export function diffPacketHash(packet: DiffPacket): string {
  return createHash("sha256").update(stableJson(packet), "utf8").digest("hex");
}

export interface FrozenPacketFiles {
  [path: string]: string; // sha256
}

/**
 * Compute changed files from two path→sha256 maps. Rename = same sha,
 * different path, unique occurrence on both sides; ambiguous → delete+add.
 */
export function computeChangedFiles(
  base: FrozenPacketFiles,
  target: FrozenPacketFiles
): ChangedFile[] {
  const out: ChangedFile[] = [];
  const baseBySha = new Map<string, string[]>();
  for (const [p, sha] of Object.entries(base)) {
    const list = baseBySha.get(sha) ?? [];
    list.push(p);
    baseBySha.set(sha, list);
  }
  const targetBySha = new Map<string, string[]>();
  for (const [p, sha] of Object.entries(target)) {
    const list = targetBySha.get(sha) ?? [];
    list.push(p);
    targetBySha.set(sha, list);
  }

  const consumedBase = new Set<string>();
  const consumedTarget = new Set<string>();
  for (const [p, sha] of Object.entries(target)) {
    const basePaths = (baseBySha.get(sha) ?? []).filter((b) => !consumedBase.has(b));
    const targetPaths = (targetBySha.get(sha) ?? []).filter((t) => !consumedTarget.has(t));
    if (!(p in base) && basePaths.length === 1 && targetPaths.length === 1) {
      out.push({
        path: p,
        status: "renamed",
        previous_path: basePaths[0]!,
        base_sha256: sha,
        target_sha256: sha
      });
      consumedBase.add(basePaths[0]!);
      consumedTarget.add(p);
    }
  }
  for (const [p, sha] of Object.entries(target)) {
    if (consumedTarget.has(p)) continue;
    if (!(p in base)) {
      out.push({ path: p, status: "added", target_sha256: sha });
    } else if (base[p] !== sha) {
      out.push({ path: p, status: "modified", base_sha256: base[p]!, target_sha256: sha });
    }
  }
  for (const [p, sha] of Object.entries(base)) {
    if (consumedBase.has(p)) continue;
    if (!(p in target)) {
      out.push({ path: p, status: "deleted", base_sha256: sha });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export type LocatorClass =
  | "touched"
  | "untouched"
  | { untouched_remap: string }
  | "unprovable";

/**
 * classifyLocator per DESIGN §4.3 — I6: only proven-untouched structured
 * locators may carry forward.
 */
export function classifyLocator(
  locator: z.infer<typeof EvidenceLocatorSchema> | null | undefined,
  changed: readonly ChangedFile[]
): LocatorClass {
  if (locator == null) return "unprovable";
  if (locator.kind !== "file_range" && locator.kind !== "artifact") {
    return "unprovable";
  }
  const p = locator.path;
  const hit = changed.find((c) => c.path === p);
  if (hit && (hit.status === "modified" || hit.status === "deleted")) {
    return "touched";
  }
  if (hit && hit.status === "added") return "touched";
  const renamed = changed.find(
    (c) => c.status === "renamed" && c.previous_path === p
  );
  if (renamed) return { untouched_remap: renamed.path };
  return "untouched";
}
