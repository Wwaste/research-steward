import path from "node:path";
import { z } from "zod";
import { ResearchStewardError, sha256Text } from "./utils.js";

/**
 * Structured evidence locators (Task 3.2). Discriminated union replacing free
 * text. Protocol v1 free-text remains a read-only legacy variant until an
 * explicit upgrade tool migrates it — never guess a parse.
 */

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const FileRangeEvidenceSchema = z
  .object({
    kind: z.literal("file_range"),
    path: z.string().min(1).max(4_096),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    page: z.number().int().positive().optional(),
    sheet: z.string().min(1).max(100).optional(),
    cell: z.string().min(1).max(32).optional(),
    content_sha256: HashSchema.optional(),
    file_sha256: HashSchema.optional()
  })
  .strict();

export const ArtifactEvidenceSchema = z
  .object({
    kind: z.literal("artifact"),
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
    doi: z.string().min(3).max(200),
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

/** Read-only legacy free text. Upgrade requires an explicit tool. */
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

export function evidenceFingerprint(locator: EvidenceLocator): string {
  return sha256Text(JSON.stringify(locator));
}

/**
 * Free-text upgrade is explicit and conservative: only a single file path
 * (optional :start-end lines) is auto-upgraded. Anything else stays free_text.
 */
export function tryUpgradeFreeText(text: string): EvidenceLocator | null {
  const trimmed = text.trim();
  const fileOnly = /^([^\s:]+)$/.exec(trimmed);
  if (fileOnly && !trimmed.includes("://")) {
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
