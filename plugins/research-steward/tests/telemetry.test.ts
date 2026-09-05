import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SpanSchema,
  TelemetryRecorder,
  redact,
  type SpanInput
} from "../src/telemetry.js";
import { EvalCaseSchema, loadEvalCases, scoreEvalRun, type EvalCase } from "../src/evaluation.js";
import { RoundtablePlanSchema } from "../src/protocol.js";

const SMOKE_DIRECTORY = fileURLToPath(new URL("../evals/smoke", import.meta.url));

const disposableDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...disposableDirectories].map((dir) => rm(dir, { recursive: true, force: true }))
  );
  disposableDirectories.clear();
});

async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "telemetry-test-"));
  disposableDirectories.add(dir);
  return dir;
}

const SHA256_FIXTURE = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const FAKE_HEX_SECRET = "deadbeefcafef00d".repeat(4);

function spanInput(attributes: Record<string, unknown> = {}): SpanInput {
  return {
    trace_id: "0af7651916cd43dd8448eb211c80319c",
    span_id: "b7ad6b7169203331",
    name: "research.node.run",
    start_time_unix_nano: "1756600000000000000",
    end_time_unix_nano: "1756600001000000000",
    attributes
  };
}

describe("redact", () => {
  it("replaces bearer tokens, API key shapes, long hex, and home paths", () => {
    expect(redact("Bearer abc.DEF-123_token")).toBe("<redacted>");
    expect(redact("leaked sk-test1234567890abcdef here")).toBe("leaked <redacted> here");
    expect(redact(`digest ${FAKE_HEX_SECRET}`)).toBe("digest <redacted>");
    expect(redact("/Users/waste/project/file.txt")).toBe("<redacted>/project/file.txt");
    expect(redact("/home/waste/project/file.txt")).toBe("<redacted>/project/file.txt");
    expect(redact("plain harmless value")).toBe("plain harmless value");
  });

  it("replaces GitHub fine-grained PATs, Slack xoxe tokens, and AWS ASIA keys", () => {
    expect(redact("github_pat_11ABCDEFG0123456789_abcdefghij")).toBe("<redacted>");
    expect(redact("token xoxe-fake-redaction-probe here")).toBe("token <redacted> here");
    expect(redact("key ASIAJ73PJQPZ7EXAMPLE used")).toBe("key <redacted> used");
  });

  it("leaves near-miss lookalikes of the new patterns alone", () => {
    expect(redact("github_pat_short")).toBe("github_pat_short");
    expect(redact("xoxe-abc")).toBe("xoxe-abc");
    expect(redact("ASIA1234 is not a key")).toBe("ASIA1234 is not a key");
  });
});

describe("SpanSchema", () => {
  it("accepts an OpenTelemetry-shaped span", () => {
    const parsed = SpanSchema.parse({
      ...spanInput({ "research.node_id": "producer-draft", "research.attempt": 1 }),
      parent_span_id: "00f067aa0ba902b7"
    });
    expect(parsed.attributes["research.node_id"]).toBe("producer-draft");
  });

  it("rejects malformed trace identifiers", () => {
    expect(() => SpanSchema.parse(spanInput())).not.toThrow();
    expect(() =>
      SpanSchema.parse({ ...spanInput(), trace_id: "not-a-trace-id" })
    ).toThrow();
  });
});

describe("TelemetryRecorder", () => {
  it("drops attribute keys outside the allowlist", async () => {
    const recorder = new TelemetryRecorder({});
    await recorder.record(
      spanInput({
        "research.node_id": "producer-draft",
        "research.status": "complete",
        "research.prompt": "RAW PROMPT MUST NEVER BE STORED",
        "research.output": "RAW OUTPUT MUST NEVER BE STORED",
        "totally.unrelated": "value"
      })
    );
    const stored = recorder.snapshot()[0]!;
    expect(Object.keys(stored.attributes).sort()).toEqual([
      "research.node_id",
      "research.status"
    ]);
    expect(JSON.stringify(recorder.snapshot())).not.toContain("RAW PROMPT");
  });

  it("redacts secret-shaped values and home paths before buffering", async () => {
    const recorder = new TelemetryRecorder({});
    await recorder.record(
      spanInput({
        "research.model": "Bearer sess.abc123token",
        "research.provider": "/Users/waste/.config/provider-cli",
        "research.status": `failed with key sk-test1234567890abcdef and hex ${FAKE_HEX_SECRET}`,
        "research.stdout_hash": SHA256_FIXTURE
      })
    );
    const serialized = JSON.stringify(recorder.snapshot());
    expect(serialized).not.toContain("sk-test1234567890abcdef");
    expect(serialized).not.toContain(FAKE_HEX_SECRET);
    expect(serialized).not.toContain("/Users/waste");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).toContain("<redacted>");
    // A well-formed sha256 digest in the dedicated hash field is a one-way
    // digest, not a credential, so it survives redaction.
    expect(recorder.snapshot()[0]!.attributes["research.stdout_hash"]).toBe(SHA256_FIXTURE);
  });

  it("redacts anything that is not a sha256 digest inside stdout_hash", async () => {
    const recorder = new TelemetryRecorder({});
    await recorder.record(spanInput({ "research.stdout_hash": "Bearer stolen-token" }));
    expect(recorder.snapshot()[0]!.attributes["research.stdout_hash"]).toBe("<redacted>");
  });

  it("never accepts raw content; opt-in only unlocks numeric char counts", async () => {
    const optedOut = new TelemetryRecorder({});
    await optedOut.record(
      spanInput({ "research.prompt_chars": 120, "research.output_chars": 64 })
    );
    expect(optedOut.snapshot()[0]!.attributes["research.prompt_chars"]).toBeUndefined();
    expect(optedOut.snapshot()[0]!.attributes["research.output_chars"]).toBeUndefined();

    const optedIn = new TelemetryRecorder({ optInRawContent: true });
    await optedIn.record(
      spanInput({
        "research.prompt_chars": 120,
        "research.output_chars": 64,
        "research.prompt": "RAW PROMPT",
        "research.output": "RAW OUTPUT"
      })
    );
    const stored = optedIn.snapshot()[0]!;
    expect(stored.attributes["research.prompt_chars"]).toBe(120);
    expect(stored.attributes["research.output_chars"]).toBe(64);
    expect(JSON.stringify(stored)).not.toContain("RAW PROMPT");
    expect(JSON.stringify(stored)).not.toContain("RAW OUTPUT");
  });

  it("stays in memory by default and produces no files", async () => {
    const scratch = await temporaryDirectory();
    const recorder = new TelemetryRecorder({});
    await recorder.record(spanInput({ "research.node_id": "n1" }));
    expect(recorder.jsonlPath).toBeUndefined();
    expect(recorder.snapshot()).toHaveLength(1);
    expect(await readdir(scratch)).toEqual([]);
  });

  it("appends parseable jsonl lines with 0600 permissions in directory mode", async () => {
    const directory = await temporaryDirectory();
    const recorder = new TelemetryRecorder({ directory });
    await recorder.record(spanInput({ "research.node_id": "n1", "research.attempt": 1 }));
    await recorder.record(spanInput({ "research.node_id": "n2", "research.duration_ms": 42 }));
    expect(recorder.jsonlPath).toBe(path.join(directory, "spans.jsonl"));
    const fileStat = await stat(recorder.jsonlPath!);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const lines = (await readFile(recorder.jsonlPath!, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => SpanSchema.parse(JSON.parse(line))).not.toThrow();
    }
    expect(SpanSchema.parse(JSON.parse(lines[1]!)).attributes["research.duration_ms"]).toBe(42);
  });

  it("exports OTLP/JSON resourceSpans and refuses to overwrite", async () => {
    const directory = await temporaryDirectory();
    const recorder = new TelemetryRecorder({});
    await recorder.record(
      spanInput({
        "research.node_id": "producer-draft",
        "research.attempt": 1,
        "research.cost_class": "fake"
      })
    );
    const destination = path.join(directory, "export.otlp.json");
    await recorder.exportOTLPFile(destination);
    const document = JSON.parse(await readFile(destination, "utf8"));
    expect(Array.isArray(document.resourceSpans)).toBe(true);
    const otlpSpan = document.resourceSpans[0].scopeSpans[0].spans[0];
    expect(otlpSpan.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(otlpSpan.spanId).toBe("b7ad6b7169203331");
    expect(otlpSpan.startTimeUnixNano).toBe("1756600000000000000");
    const attempt = otlpSpan.attributes.find(
      (attribute: { key: string }) => attribute.key === "research.attempt"
    );
    expect(attempt.value).toEqual({ intValue: "1" });
    const costClass = otlpSpan.attributes.find(
      (attribute: { key: string }) => attribute.key === "research.cost_class"
    );
    expect(costClass.value).toEqual({ stringValue: "fake" });

    const before = await readFile(destination, "utf8");
    await expect(recorder.exportOTLPFile(destination)).rejects.toMatchObject({
      code: "EEXIST"
    });
    expect(await readFile(destination, "utf8")).toBe(before);
  });
});

function evalCase(
  caseId: string,
  findings: Array<{ id: string; must_flag: boolean }>,
  acceptableDispositions: Record<string, string[]> = {},
  undecidable?: string[]
): EvalCase {
  return EvalCaseSchema.parse({
    case_id: caseId,
    description: `Inline fixture ${caseId} for scoring tests.`,
    input: { kind: "fake_roundtable", plan: { version: 1, nodes: [] } },
    expected: {
      findings,
      acceptable_dispositions: acceptableDispositions,
      ...(undecidable ? { undecidable } : {})
    },
    provenance: {
      author: "test-fixture",
      created_at: "2026-08-31T12:00:00+08:00",
      adjudication_basis: "Hand-labeled inline fixture; no model output involved."
    }
  });
}

describe("loadEvalCases", () => {
  it("loads and validates every smoke case", async () => {
    const cases = await loadEvalCases(SMOKE_DIRECTORY);
    expect(cases.length).toBeGreaterThanOrEqual(2);
    const ids = cases.map((entry) => entry.case_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of cases) {
      expect(entry.input.kind).toBe("fake_roundtable");
      expect(entry.expected.findings.length).toBeGreaterThan(0);
      expect(entry.provenance.adjudication_basis.length).toBeGreaterThan(0);
    }
    expect(
      cases.some((entry) => (entry.expected.undecidable ?? []).length > 0)
    ).toBe(true);
  });

  it("rejects a malformed case file with a coded error", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, "broken.json"),
      JSON.stringify({ case_id: "broken", description: "missing everything" }),
      "utf8"
    );
    await expect(loadEvalCases(directory)).rejects.toMatchObject({
      code: "EVAL_CASE_INVALID"
    });
  });

  it("rejects unparseable JSON with a coded error", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "not-json.json"), "{nope", "utf8");
    await expect(loadEvalCases(directory)).rejects.toMatchObject({
      code: "EVAL_CASE_INVALID"
    });
  });

  it("rejects two files sharing one case_id", async () => {
    const directory = await temporaryDirectory();
    const body = {
      case_id: "dup-case",
      description: "First of two files with the same case_id.",
      input: { kind: "fake_roundtable", plan: { version: 1, nodes: [] } },
      expected: {
        findings: [{ id: "f1", must_flag: true }],
        acceptable_dispositions: {}
      },
      provenance: {
        author: "test-fixture",
        created_at: "2026-08-31T12:00:00+08:00",
        adjudication_basis: "Hand-labeled duplicate fixture."
      }
    };
    await writeFile(path.join(directory, "a.json"), JSON.stringify(body), "utf8");
    await writeFile(path.join(directory, "b.json"), JSON.stringify(body), "utf8");
    await expect(loadEvalCases(directory)).rejects.toMatchObject({
      code: "EVAL_CASE_DUPLICATE"
    });
  });

  it("commits only zero-cost plans: every smoke plan parses and uses the fake adapter", async () => {
    const cases = await loadEvalCases(SMOKE_DIRECTORY);
    for (const entry of cases) {
      const plan = RoundtablePlanSchema.parse(entry.input.plan);
      expect(plan.nodes.length).toBeGreaterThan(0);
      for (const node of plan.nodes) {
        expect(node.adapter).toBe("fake");
      }
    }
  });

  it("rejects a directory without cases", async () => {
    const directory = await temporaryDirectory();
    await expect(loadEvalCases(directory)).rejects.toMatchObject({
      code: "EVAL_NO_CASES"
    });
  });
});

describe("scoreEvalRun", () => {
  it("matches hand-computed precision, recall, fnr, and fpr", () => {
    // Labels: m1..m3 must be flagged, n1..n2 must not.
    // Run flags m1, m2, n1 -> TP=2, FN=1 (m3), FP=1 (n1), TN=1 (n2).
    const fixture = evalCase(
      "case-hand",
      [
        { id: "m1", must_flag: true },
        { id: "m2", must_flag: true },
        { id: "m3", must_flag: true },
        { id: "n1", must_flag: false },
        { id: "n2", must_flag: false }
      ],
      { m1: ["accept"], m2: ["accept", "partial"] }
    );
    const score = scoreEvalRun([fixture], {
      "case-hand": {
        flagged: ["m1", "m2", "n1"],
        dispositions: { m1: "accept", m2: "reject" }
      }
    });
    expect(score.precision).toBeCloseTo(2 / 3, 10);
    expect(score.recall).toBeCloseTo(2 / 3, 10);
    expect(score.fnr).toBeCloseTo(1 / 3, 10);
    expect(score.fpr).toBeCloseTo(1 / 2, 10);
    expect(score.missed).toEqual([{ case_id: "case-hand", finding_id: "m3" }]);
    const perCase = score.per_case[0]!;
    expect(perCase.true_positives).toBe(2);
    expect(perCase.false_positives).toBe(1);
    expect(perCase.false_negatives).toBe(1);
    expect(perCase.true_negatives).toBe(1);
    expect(perCase.disposition_total).toBe(2);
    expect(perCase.disposition_matches).toBe(1);
    expect(perCase.disposition_mismatches).toEqual(["m2"]);
  });

  it("returns null metrics with a note when a denominator is zero", () => {
    const fixture = evalCase("case-empty", [{ id: "n1", must_flag: false }]);
    const score = scoreEvalRun([fixture], {
      "case-empty": { flagged: [], dispositions: {} }
    });
    expect(score.precision).toBeNull();
    expect(score.recall).toBeNull();
    expect(score.fnr).toBeNull();
    expect(score.fpr).toBe(0);
    expect(score.notes.join(" ")).toContain("insufficient sample");
  });

  it("excludes undecidable findings from every count", () => {
    const fixture = evalCase(
      "case-undecidable",
      [
        { id: "u1", must_flag: true },
        { id: "u2", must_flag: true }
      ],
      {},
      ["u2"]
    );
    const score = scoreEvalRun([fixture], {
      "case-undecidable": { flagged: ["u1"], dispositions: {} }
    });
    expect(score.recall).toBe(1);
    expect(score.missed).toEqual([]);
    const perCase = score.per_case[0]!;
    expect(perCase.false_negatives).toBe(0);
    expect(perCase.undecidable_excluded).toEqual(["u2"]);
  });

  it("treats a case without a result as an all-miss run", () => {
    const fixture = evalCase("case-skipped", [{ id: "m1", must_flag: true }]);
    const score = scoreEvalRun([fixture], {});
    expect(score.per_case[0]!.result_missing).toBe(true);
    expect(score.recall).toBe(0);
    expect(score.missed).toEqual([{ case_id: "case-skipped", finding_id: "m1" }]);
  });

  it("scores the committed smoke cases without touching any model", async () => {
    const cases = await loadEvalCases(SMOKE_DIRECTORY);
    const perfect = Object.fromEntries(
      cases.map((entry) => {
        const undecidable = new Set(entry.expected.undecidable ?? []);
        return [
          entry.case_id,
          {
            flagged: entry.expected.findings
              .filter((finding) => finding.must_flag && !undecidable.has(finding.id))
              .map((finding) => finding.id),
            dispositions: Object.fromEntries(
              Object.entries(entry.expected.acceptable_dispositions)
                .filter(([findingId]) => !undecidable.has(findingId))
                .map(([findingId, accepted]) => [findingId, accepted[0]!])
            )
          }
        ];
      })
    );
    const score = scoreEvalRun(cases, perfect);
    expect(score.recall).toBe(1);
    expect(score.fnr).toBe(0);
    expect(score.missed).toEqual([]);
  });
});
