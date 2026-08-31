import { z } from "zod";

/**
 * Failure taxonomy for provider invocations. Every provider error observed by
 * the workflow is reduced to one of these classes before any retry decision
 * is made, so the retry policy never reasons about raw error strings.
 */
export const FailureClassSchema = z.enum([
  "quota",
  "auth",
  "model_not_found",
  "timeout",
  "transport",
  "invalid_output",
  "cancelled",
  "unknown"
]);

export type FailureClass = z.infer<typeof FailureClassSchema>;

/**
 * Multilingual pattern fixtures for stderr excerpts, one array per failure
 * class. They intentionally cover several languages and phrasings because a
 * provider CLI may localize its diagnostics; classification must never hinge
 * on a single English sentence. Extend an array to teach the classifier a new
 * provider dialect without touching the decision logic.
 */
export const QUOTA_STDERR_PATTERNS: readonly RegExp[] = [
  // "Disk quota exceeded" is a filesystem error, not an API budget problem,
  // so a quota directly preceded by "disk" does not count.
  /(?<!disk\s)\bquotas?\b/i,
  /rate.?limit/i,
  /too many requests/i,
  // A bare "429" is too ambiguous ("took 429 ms"), so the status number only
  // counts when the same excerpt also carries an HTTP-ish context word.
  /(?=[\s\S]*\b429\b)(?=[\s\S]*\b(?:error|status|http|too many)\b)/i,
  /额度/,
  /配额/,
  /限流/
];

export const AUTH_STDERR_PATTERNS: readonly RegExp[] = [
  /unauthori[sz]ed/i,
  /\b401\b/,
  /token.*expired/i,
  /auth(entication|orization)?\s*(fail|error|expired|required)/i,
  // Word boundaries keep login/log in/log-in matching while excluding
  // logging, syslog, catalog, backlog, and dialog.
  /\blog.?in\b/i,
  /登录/,
  /认证失败/,
  /凭证/
];

export const MODEL_NOT_FOUND_STDERR_PATTERNS: readonly RegExp[] = [
  /(unknown|invalid|unsupported)\s+model/i,
  // "model ... not found" only counts when the excerpt is about the model
  // itself; the lookahead rejects file diagnostics such as
  // "model output file not found".
  /model\b(?![\s\S]*\boutput\b)[\s\S]*\bnot\b[\s\S]*\b(found|available|supported)\b/i,
  /no such model/i,
  /模型.*不存在/,
  /模型.*未找到/,
  /不存在.*模型/
];

/**
 * Pattern sets are consulted in this order. Quota wins over auth because a
 * throttled response often also mentions the account, and both win over the
 * broader model lookup patterns.
 */
const PATTERN_SETS: ReadonlyArray<readonly [FailureClass, readonly RegExp[]]> = [
  ["quota", QUOTA_STDERR_PATTERNS],
  ["auth", AUTH_STDERR_PATTERNS],
  ["model_not_found", MODEL_NOT_FOUND_STDERR_PATTERNS]
];

export interface ProviderFailureSignals {
  /**
   * Sanitized stderr excerpt strings supplied by the caller, for example a
   * redacted tail of the provider diagnostics. These are the only text the
   * classifier ever reads. The real system persists only stderr hashes; when
   * the caller holds nothing but a hash it must leave this empty, and an exit
   * failure then classifies as "unknown" rather than guessing.
   */
  stderr_patterns?: string[];
}

export interface ProviderFailureInput {
  /** ResearchStewardError code, when the failure carried one. */
  code?: string;
  exit_code?: number;
  /** Hash of the stderr excerpt; carried for evidence, never matched on. */
  stderr_excerpt_hash?: string;
  adapter: string;
  signals?: ProviderFailureSignals;
}

export interface DetailedFailureClassification {
  failure_class: FailureClass;
  classified_by: "structured" | "pattern" | "default";
}

/**
 * Structured error codes map directly to a class without reading any text.
 * These codes come from src/providers.ts, plus the explicit cancellation
 * codes a coordinator may raise when it aborts a run on purpose.
 */
const STRUCTURED_CODE_CLASSES: ReadonlyMap<string, FailureClass> = new Map([
  ["PROVIDER_TIMEOUT", "timeout"],
  ["PROVIDER_QUEUE_TIMEOUT", "timeout"],
  ["MODEL_OUTPUT_REJECTED", "invalid_output"],
  ["PROVIDER_OUTPUT_LIMIT", "invalid_output"],
  ["PROVIDER_SPAWN_FAILED", "transport"],
  ["PROVIDER_CANCELLED", "cancelled"],
  ["CANCELLED", "cancelled"]
]);

/**
 * Classifies a provider failure and reports which mechanism decided it.
 * Structured codes always win; pattern matching only applies to
 * PROVIDER_EXIT_FAILED, where the process ran but its own diagnostics are the
 * only clue; everything else falls through to the "unknown" default.
 */
export function classifyProviderFailureDetailed(
  input: ProviderFailureInput
): DetailedFailureClassification {
  const structured = input.code ? STRUCTURED_CODE_CLASSES.get(input.code) : undefined;
  if (structured) {
    return { failure_class: structured, classified_by: "structured" };
  }

  if (input.code === "PROVIDER_EXIT_FAILED") {
    const excerpts = input.signals?.stderr_patterns ?? [];
    for (const [failureClass, patterns] of PATTERN_SETS) {
      for (const excerpt of excerpts) {
        if (patterns.some((pattern) => pattern.test(excerpt))) {
          return { failure_class: failureClass, classified_by: "pattern" };
        }
      }
    }
  }

  return { failure_class: "unknown", classified_by: "default" };
}

export function classifyProviderFailure(input: ProviderFailureInput): FailureClass {
  return classifyProviderFailureDetailed(input).failure_class;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Auditable record of one classified failure attempt. It carries only hashed
 * diagnostics and structured fields, matching what src/providers.ts already
 * exposes in error details, so it can be committed to the event ledger
 * without leaking raw provider output.
 */
export const FailureEvidenceSchema = z
  .object({
    failure_class: FailureClassSchema,
    provider_code: z.string().min(1).max(100).optional(),
    exit_code: z.number().int().optional(),
    stdout_hash: z.string().regex(SHA256_HEX).optional(),
    stderr_hash: z.string().regex(SHA256_HEX).optional(),
    attempt: z.number().int().min(1),
    classified_by: z.enum(["structured", "pattern", "default"])
  })
  .strict();

export type FailureEvidence = z.infer<typeof FailureEvidenceSchema>;
