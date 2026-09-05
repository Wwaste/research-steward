import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeImmutableFile } from "./utils.js";

// Telemetry for Research Steward runs, shaped after the OpenTelemetry span
// data model so a later exporter can hand spans to any OTLP backend without a
// schema rewrite. This module is privacy-first:
//
//   * Attribute keys outside SPAN_ATTRIBUTE_ALLOWLIST are dropped, always.
//   * Every string value passes redact() before it is buffered or written.
//   * Raw prompt or output text is NEVER accepted by this module, not even
//     with optInRawContent. The opt-in only unlocks the numeric
//     "research.prompt_chars" / "research.output_chars" counters. Whether a
//     project ever records raw content traces is a project-level opt-in and a
//     wiring decision deferred to a later task; this recorder is deliberately
//     incapable of storing raw content so that decision cannot leak backwards.

const HEX_64 = /^[0-9a-f]{64}$/;

// Secret-shaped material is replaced with "<redacted>". Patterns cover, in
// order: bearer tokens, common API-key prefixes (sk-/pk-/rk-, GitHub, Slack,
// AWS access keys, generic key/token/secret prefixes), 64-or-more hex chars
// (credential dumps and raw digests), and absolute home paths.
const REDACTION_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bxoxe-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\b(?:api|key|token|secret)[-_][A-Za-z0-9._-]{12,}/gi,
  /[0-9a-fA-F]{64,}/g,
  /\/Users\/[^/\s"']+/g,
  /\/home\/[^/\s"']+/g
];

// Known boundary: patterns run sequentially over the already-rewritten
// string, so a replacement can change the value's length and, in theory, two
// adjacent fragments could concatenate into a new secret-shaped substring that
// a later pass would need to catch. Accepted as-is: the substitute text
// "<redacted>" contains no charset any pattern matches, so no such fragment
// can be manufactured by the rewriting itself.
export function redact(value: string): string {
  let output = value;
  for (const pattern of REDACTION_PATTERNS) {
    output = output.replace(pattern, "<redacted>");
  }
  return output;
}

const STRING_ATTRIBUTE = z.string().min(1).max(4_000);

export const SpanSchema = z
  .object({
    trace_id: z.string().regex(/^[0-9a-f]{32}$/),
    span_id: z.string().regex(/^[0-9a-f]{16}$/),
    parent_span_id: z.string().regex(/^[0-9a-f]{16}$/).optional(),
    name: z.string().min(1).max(200),
    // OTLP/JSON encodes 64-bit nanosecond timestamps as decimal strings
    // because they exceed Number.MAX_SAFE_INTEGER. Known boundary: the
    // pattern bounds digit count (<= 20) but not the int64 maximum
    // 9223372036854775807, so a value between 2^63-1 and 10^20-1 would pass
    // schema validation yet overflow a strict OTLP consumer.
    start_time_unix_nano: z.string().regex(/^\d{1,20}$/),
    end_time_unix_nano: z.string().regex(/^\d{1,20}$/),
    attributes: z
      .object({
        "research.run_id": STRING_ATTRIBUTE.optional(),
        "research.node_id": STRING_ATTRIBUTE.optional(),
        "research.actor_id": STRING_ATTRIBUTE.optional(),
        "research.provider": STRING_ATTRIBUTE.optional(),
        "research.model": STRING_ATTRIBUTE.optional(),
        "research.attempt": z.number().int().min(1).optional(),
        "research.status": STRING_ATTRIBUTE.optional(),
        "research.queue_ms": z.number().min(0).optional(),
        "research.duration_ms": z.number().min(0).optional(),
        "research.stdout_hash": STRING_ATTRIBUTE.optional(),
        "research.cost_class": z.enum(["subscription_cli", "fake"]).optional(),
        // Present only when the recorder was constructed with
        // optInRawContent: true. Character counts only; never raw text.
        "research.prompt_chars": z.number().int().min(0).optional(),
        "research.output_chars": z.number().int().min(0).optional()
      })
      .strict()
  })
  .strict();

export type Span = z.infer<typeof SpanSchema>;

export const SPAN_ATTRIBUTE_ALLOWLIST: readonly string[] = [
  "research.run_id",
  "research.node_id",
  "research.actor_id",
  "research.provider",
  "research.model",
  "research.attempt",
  "research.status",
  "research.queue_ms",
  "research.duration_ms",
  "research.stdout_hash",
  "research.cost_class"
];

const OPT_IN_NUMERIC_KEYS: readonly string[] = [
  "research.prompt_chars",
  "research.output_chars"
];

export interface SpanInput {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  start_time_unix_nano: string;
  end_time_unix_nano: string;
  attributes?: Record<string, unknown>;
}

function sanitizeAttributeValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (key === "research.stdout_hash") {
    // A sha256 digest is a one-way fingerprint recorded on purpose by
    // runOneNode; it is not a credential. Anything that is not exactly a
    // lowercase 64-hex digest is treated as untrusted and fully redacted.
    return HEX_64.test(value) ? value : "<redacted>";
  }
  return redact(value);
}

function sanitizeSpan(input: SpanInput, optInRawContent: boolean): Span {
  const attributes: Record<string, unknown> = {};
  const source = input.attributes ?? {};
  for (const key of SPAN_ATTRIBUTE_ALLOWLIST) {
    if (key in source && source[key] !== undefined) {
      attributes[key] = sanitizeAttributeValue(key, source[key]);
    }
  }
  if (optInRawContent) {
    for (const key of OPT_IN_NUMERIC_KEYS) {
      // Numbers only. Raw prompt/output text has no accepted key at all.
      if (typeof source[key] === "number") {
        attributes[key] = source[key];
      }
    }
  }
  return SpanSchema.parse({
    trace_id: input.trace_id,
    span_id: input.span_id,
    ...(input.parent_span_id ? { parent_span_id: input.parent_span_id } : {}),
    name: redact(input.name),
    start_time_unix_nano: input.start_time_unix_nano,
    end_time_unix_nano: input.end_time_unix_nano,
    attributes
  });
}

type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number };

function toOtlpValue(value: unknown): OtlpAttributeValue {
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: String(value) };
}

export interface TelemetryRecorderOptions {
  directory?: string;
  optInRawContent?: boolean;
}

export class TelemetryRecorder {
  public readonly jsonlPath: string | undefined;

  private readonly optInRawContent: boolean;
  private readonly buffer: Span[] = [];
  private directoryReady = false;

  public constructor(options: TelemetryRecorderOptions = {}) {
    // Default is memory-only: no directory means nothing ever touches disk.
    this.jsonlPath = options.directory
      ? path.join(options.directory, "spans.jsonl")
      : undefined;
    this.optInRawContent = options.optInRawContent === true;
  }

  public snapshot(): readonly Span[] {
    return [...this.buffer];
  }

  public async record(input: SpanInput): Promise<Span> {
    const span = sanitizeSpan(input, this.optInRawContent);
    this.buffer.push(span);
    if (this.jsonlPath) {
      await this.appendLine(JSON.stringify(span));
    }
    return span;
  }

  private async appendLine(line: string): Promise<void> {
    if (!this.jsonlPath) return;
    if (!this.directoryReady) {
      await mkdir(path.dirname(this.jsonlPath), { recursive: true, mode: 0o700 });
      this.directoryReady = true;
    }
    // O_APPEND plus a single write of the whole line keeps concurrent
    // appenders from interleaving partial records; 0o600 keeps the file
    // owner-only from the moment it exists. Known boundary: that atomicity
    // relies on platform semantics for single-write appends (safe for lines
    // around typical span size, not guaranteed for arbitrarily long lines),
    // and the test suite does not assert multi-process interleaving.
    const handle = await open(this.jsonlPath, "a", 0o600);
    try {
      await handle.writeFile(`${line}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  public async exportOTLPFile(destination: string): Promise<void> {
    const document = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "research-steward" } }
            ]
          },
          scopeSpans: [
            {
              scope: { name: "research-steward.telemetry", version: "0.2.0" },
              spans: this.buffer.map((span) => ({
                traceId: span.trace_id,
                spanId: span.span_id,
                ...(span.parent_span_id ? { parentSpanId: span.parent_span_id } : {}),
                name: span.name,
                kind: 1,
                startTimeUnixNano: span.start_time_unix_nano,
                endTimeUnixNano: span.end_time_unix_nano,
                attributes: Object.entries(span.attributes).map(([key, value]) => ({
                  key,
                  value: toOtlpValue(value)
                }))
              }))
            }
          ]
        }
      ]
    };
    // writeImmutableFile opens with "wx": an existing file is never
    // overwritten and the caller sees the EEXIST error unchanged.
    await writeImmutableFile(destination, `${JSON.stringify(document, null, 2)}\n`);
  }
}
