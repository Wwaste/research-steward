import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { ResearchStewardError, sha256Text, stableJson } from "./utils.js";
import { validateRelativePath } from "./paths.js";

/**
 * Structured evidence locators — module layer (DESIGN-EVIDENCE-UNION §2).
 * The discriminated union definition moves to protocol.ts in step ① (shared
 * surface, Phase 2 gate); this file keeps upgrade/fingerprint/validate
 * functions and the locator shapes until then.
 */

// TODO(gate): migrate to protocol.HashSchema in step ①b (CR-M-066).
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const FileRangeEvidenceSchema = z
  .object({
    kind: z.literal("file_range"),
    packet_id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
    path: z.string().min(1).max(4_096),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    page: z.number().int().positive().optional(),
    sheet: z.string().min(1).max(100).optional(),
    cell: z.string().min(1).max(32).optional(),
    anchor: z.string().min(1).max(200).optional(),
    content_sha256: HashSchema.optional(),
    file_sha256: HashSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.start_line !== undefined &&
      value.end_line !== undefined &&
      value.end_line < value.start_line
    ) {
      ctx.addIssue({ code: "custom", message: "end_line must be >= start_line" });
    }
    if (
      value.content_sha256 !== undefined &&
      (value.start_line === undefined || value.end_line === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "content_sha256 requires start_line and end_line"
      });
    }
  });

export const ArtifactEvidenceSchema = z
  .object({
    kind: z.literal("artifact"),
    packet_id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
    path: z.string().min(1).max(4_096),
    file_sha256: HashSchema,
    media_type: z.string().min(1).max(100).optional()
  })
  .strict();

export const CommandResultEvidenceSchema = z
  .object({
    kind: z.literal("command_result"),
    executable: z.string().min(1).max(200),
    argv: z.array(z.string().max(2_000)).max(64),
    /** Project-relative cwd (DESIGN §1). */
    cwd: z.string().min(1).max(4_096),
    exit_code: z.number().int(),
    stdout_sha256: HashSchema,
    stderr_sha256: HashSchema,
    tool_version: z.string().max(200).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const arg of value.argv) {
      if (arg.includes("\0")) {
        ctx.addIssue({ code: "custom", message: "argv must not contain NUL" });
      }
    }
    try {
      validateRelativePath(value.cwd);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "cwd must be a project-relative path without .. or absolute prefixes"
      });
    }
  });

export const UrlEvidenceSchema = z
  .object({
    kind: z.literal("url"),
    url: z.string().url().max(4_096),
    retrieved_at: z.string().datetime({ offset: true }),
    content_sha256: HashSchema
  })
  .strict();

export const DoiEvidenceSchema = z
  .object({
    kind: z.literal("doi"),
    doi: z.string().min(3).max(200).regex(/^10\.\d{4,9}\/\S{1,190}$/i),
    retrieved_at: z.string().datetime({ offset: true }).optional(),
    metadata_sha256: HashSchema.optional()
  })
  .strict();

export const DatasetRecordEvidenceSchema = z
  .object({
    kind: z.literal("dataset_record"),
    dataset_id: z.string().min(1).max(200),
    record_key: z.string().min(1).max(500),
    snapshot_sha256: HashSchema.optional()
  })
  .strict();

export const FreeTextEvidenceSchema = z
  .object({
    kind: z.literal("free_text"),
    text: z.string().min(1).max(4_000),
    legacy: z.literal(true)
  })
  .strict();

export const EvidenceLocatorSchema = z.discriminatedUnion("kind", [
  FileRangeEvidenceSchema,
  ArtifactEvidenceSchema,
  CommandResultEvidenceSchema,
  UrlEvidenceSchema,
  DoiEvidenceSchema,
  DatasetRecordEvidenceSchema,
  FreeTextEvidenceSchema
]);

export type EvidenceLocator = z.infer<typeof EvidenceLocatorSchema>;

export function parseEvidenceLocator(raw: unknown): EvidenceLocator {
  return EvidenceLocatorSchema.parse(raw);
}

/** CR-M / DESIGN §2: stableJson so key order cannot change the fingerprint. */
export function evidenceFingerprint(locator: EvidenceLocator): string {
  return sha256Text(stableJson(locator));
}

/**
 * content_sha256: sha256 over the raw byte range [start_line, end_line]
 * (1-based, inclusive) split on 0x0A, including each LF except a missing
 * trailing LF on the last line. No encoding or CRLF normalization.
 */
export function hashFileLineRange(
  bytes: Buffer,
  startLine: number,
  endLine: number
): string {
  // Split on raw 0x0A; no encoding or CRLF normalization (DESIGN §1).
  // A file without LF is a single line (binary case).
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a) {
      parts.push(bytes.subarray(start, i + 1)); // include LF
      start = i + 1;
    }
  }
  if (start < bytes.length) parts.push(bytes.subarray(start));
  if (startLine < 1 || endLine > parts.length || endLine < startLine) {
    throw new ResearchStewardError(
      "EVIDENCE_LINE_RANGE_INVALID",
      "start_line/end_line must lie within the file."
    );
  }
  const chunk = Buffer.concat(parts.slice(startLine - 1, endLine));
  return createHash("sha256").update(chunk).digest("hex");
}

export function tryUpgradeFreeText(text: string): EvidenceLocator | null {
  const trimmed = text.trim();
  const fileOnly = /^([^\s:]+)$/.exec(trimmed);
  if (fileOnly) {
    return FileRangeEvidenceSchema.parse({ kind: "file_range", path: trimmed });
  }
  const fileLines = /^([^\s:]+):(\d+)-(\d+)$/.exec(trimmed);
  if (fileLines) {
    const start = Number(fileLines[2]);
    const end = Number(fileLines[3]);
    if (end >= start) {
      return FileRangeEvidenceSchema.parse({
        kind: "file_range",
        path: fileLines[1]!,
        start_line: start,
        end_line: end
      });
    }
  }
  return null;
}

export function upgradeOrKeepFreeText(text: string): EvidenceLocator {
  const upgraded = tryUpgradeFreeText(text);
  if (upgraded) return upgraded;
  return FreeTextEvidenceSchema.parse({ kind: "free_text", text, legacy: true });
}

export function assertNoPathEscape(projectRoot: string, evidencePath: string): void {
  try {
    validateRelativePath(evidencePath);
  } catch (error) {
    throw new ResearchStewardError(
      "EVIDENCE_PATH_ESCAPE",
      "Evidence path must stay inside the project root.",
      { reason: (error as Error).message }
    );
  }
  const relative = path.relative(projectRoot, path.resolve(projectRoot, evidencePath));
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new ResearchStewardError(
      "EVIDENCE_PATH_ESCAPE",
      "Evidence path must stay inside the project root."
    );
  }
}
