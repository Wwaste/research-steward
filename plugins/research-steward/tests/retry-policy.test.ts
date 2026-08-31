import { describe, expect, it } from "vitest";
import {
  AUTH_STDERR_PATTERNS,
  FailureClassSchema,
  FailureEvidenceSchema,
  MODEL_NOT_FOUND_STDERR_PATTERNS,
  QUOTA_STDERR_PATTERNS,
  classifyProviderFailure,
  classifyProviderFailureDetailed,
  type FailureClass
} from "../src/provider-failure.js";
import {
  RetryPolicySchema,
  assertInvocationBudget,
  decideRetry,
  maxAttemptsFor,
  policyFromPlanLimits,
  type RetryPolicy
} from "../src/retry-policy.js";
import { ResearchStewardError } from "../src/utils.js";

/**
 * Provider failure fixtures shaped like ResearchStewardError projections:
 * { code, details } plus the sanitized stderr excerpt a caller may hold
 * separately from the hashed details. The excerpt never appears in details,
 * mirroring the real system where details only carry hashes.
 */
interface FailureFixture {
  code: string;
  details: Record<string, unknown>;
  stderr_excerpt?: string;
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function exitFailedFixture(stderrExcerpt: string): FailureFixture {
  return {
    code: "PROVIDER_EXIT_FAILED",
    details: {
      duration_ms: 1200,
      exit_code: 1,
      stdout_hash: HASH_A,
      stdout_chars: 0,
      stderr_hash: HASH_B,
      stderr_chars: stderrExcerpt.length
    },
    stderr_excerpt: stderrExcerpt
  };
}

function classifyFixture(fixture: FailureFixture): FailureClass {
  return classifyProviderFailure({
    code: fixture.code,
    exit_code: fixture.details["exit_code"] as number | undefined,
    stderr_excerpt_hash: fixture.details["stderr_hash"] as string | undefined,
    adapter: "qoder",
    ...(fixture.stderr_excerpt !== undefined
      ? { signals: { stderr_patterns: [fixture.stderr_excerpt] } }
      : {})
  });
}

describe("classifyProviderFailure structured codes", () => {
  const structuredCases: Array<[string, FailureClass]> = [
    ["PROVIDER_TIMEOUT", "timeout"],
    ["PROVIDER_QUEUE_TIMEOUT", "timeout"],
    ["MODEL_OUTPUT_REJECTED", "invalid_output"],
    ["PROVIDER_OUTPUT_LIMIT", "invalid_output"],
    ["PROVIDER_SPAWN_FAILED", "transport"],
    ["PROVIDER_CANCELLED", "cancelled"],
    ["CANCELLED", "cancelled"]
  ];

  for (const [code, expected] of structuredCases) {
    it(`maps ${code} to ${expected} without consulting stderr text`, () => {
      const classified = classifyProviderFailure({ code, adapter: "grok" });
      expect(classified).toBe(expected);
      const detailed = classifyProviderFailureDetailed({ code, adapter: "grok" });
      expect(detailed.failure_class).toBe(expected);
      expect(detailed.classified_by).toBe("structured");
    });
  }

  it("returns unknown for an unrecognized code and for a missing code", () => {
    expect(classifyProviderFailure({ code: "SOMETHING_ELSE", adapter: "kimi" })).toBe("unknown");
    expect(classifyProviderFailure({ adapter: "kimi" })).toBe("unknown");
    expect(
      classifyProviderFailureDetailed({ adapter: "kimi" }).classified_by
    ).toBe("default");
  });

  it("treats structured codes as exact case-sensitive contracts", () => {
    // The provider layer emits uppercase codes; anything else is not the
    // structured contract and must fall through to unknown instead of being
    // fuzzily accepted.
    expect(classifyProviderFailure({ code: "provider_timeout", adapter: "kimi" })).toBe(
      "unknown"
    );
    expect(classifyProviderFailure({ code: "Provider_Timeout", adapter: "kimi" })).toBe(
      "unknown"
    );
    expect(classifyProviderFailure({ code: "cancelled", adapter: "kimi" })).toBe("unknown");
  });

  it("prefers a structured code over contradicting stderr patterns", () => {
    // A timeout stays a timeout even if the sanitized stderr happens to
    // mention quota-like text; structured signals outrank pattern matching.
    const classified = classifyProviderFailure({
      code: "PROVIDER_TIMEOUT",
      adapter: "kimi",
      signals: { stderr_patterns: ["quota exceeded"] }
    });
    expect(classified).toBe("timeout");
  });
});

describe("classifyProviderFailure PROVIDER_EXIT_FAILED pattern matching", () => {
  const multilingualSamples: Record<
    "quota" | "auth" | "model_not_found",
    string[]
  > = {
    quota: [
      "Error: quota exceeded for this billing period",
      "HTTP 429 Too Many Requests, slow down",
      "rate-limit reached, please retry later",
      "本月额度已用尽，请升级套餐",
      "请求被限流：配额不足"
    ],
    auth: [
      "Error: unauthorized request",
      "server rejected the call with status 401",
      "your token has expired, run auth flow again",
      "authentication failed, please login again",
      "登录态已失效，请重新登录",
      "认证失败：凭证无效"
    ],
    model_not_found: [
      'model "glm-99" not found on this endpoint',
      "unknown model: kimi-code/k9",
      "no such model is available for your plan",
      "指定的模型不存在，请检查模型名称"
    ]
  };

  for (const [expected, samples] of Object.entries(multilingualSamples)) {
    it(`classifies ${expected} from several languages, not one English phrase`, () => {
      // Every sample of the class must classify identically, and the samples
      // deliberately mix Chinese and distinct English phrasings so a single
      // hardcoded English message cannot satisfy this test.
      const chineseSamples = samples.filter((sample) => /[一-鿿]/.test(sample));
      const englishSamples = samples.filter((sample) => !/[一-鿿]/.test(sample));
      expect(chineseSamples.length).toBeGreaterThanOrEqual(1);
      expect(englishSamples.length).toBeGreaterThanOrEqual(2);
      for (const sample of samples) {
        const fixture = exitFailedFixture(sample);
        expect(classifyFixture(fixture), `sample: ${sample}`).toBe(expected);
      }
    });
  }

  it("reports classified_by pattern when an excerpt matches", () => {
    const detailed = classifyProviderFailureDetailed({
      code: "PROVIDER_EXIT_FAILED",
      exit_code: 1,
      adapter: "qoder",
      signals: { stderr_patterns: ["HTTP 429 Too Many Requests"] }
    });
    expect(detailed).toEqual({ failure_class: "quota", classified_by: "pattern" });
  });

  it("returns unknown when the real system only holds a stderr hash", () => {
    // The classifier never touches raw provider output. When the caller only
    // has hashed diagnostics, it must not pass the hash as an excerpt, and
    // classification of an exit failure degrades to unknown.
    const hashOnly = classifyProviderFailure({
      code: "PROVIDER_EXIT_FAILED",
      exit_code: 1,
      stderr_excerpt_hash: HASH_B,
      adapter: "qoder"
    });
    expect(hashOnly).toBe("unknown");
    const detailed = classifyProviderFailureDetailed({
      code: "PROVIDER_EXIT_FAILED",
      exit_code: 1,
      stderr_excerpt_hash: HASH_B,
      adapter: "qoder",
      signals: { stderr_patterns: [] }
    });
    expect(detailed).toEqual({ failure_class: "unknown", classified_by: "default" });
  });

  it("keeps every reviewer counterexample out of all pattern classes", () => {
    // Negative fixtures: plausible provider stderr lines that superficially
    // resemble a pattern word but describe something else entirely. Each one
    // must classify as unknown, or the pattern sets are too greedy.
    const negativeFixtures = [
      "logging enabled",
      "console logging",
      "syslog",
      "catalog",
      "backlog",
      "dialog input",
      "max tokens exceeded",
      "model output file not found",
      "Disk quota exceeded",
      "took 429 ms"
    ];
    for (const sample of negativeFixtures) {
      expect(classifyFixture(exitFailedFixture(sample)), `sample: ${sample}`).toBe(
        "unknown"
      );
    }
  });

  it("applies class priority over excerpt order when several excerpts match", () => {
    // The quota set is consulted before model_not_found, so a quota hit in a
    // later excerpt outranks a model hit in an earlier one.
    const classified = classifyProviderFailure({
      code: "PROVIDER_EXIT_FAILED",
      exit_code: 1,
      adapter: "qoder",
      signals: { stderr_patterns: ["unknown model: glm-99", "quota exceeded"] }
    });
    expect(classified).toBe("quota");
  });

  it("returns unknown for stderr text that matches no pattern set", () => {
    expect(classifyFixture(exitFailedFixture("segmentation fault (core dumped)"))).toBe(
      "unknown"
    );
    expect(classifyFixture(exitFailedFixture("发生了一个内部错误"))).toBe("unknown");
  });

  it("exports the pattern sets as non-empty extensible constants", () => {
    for (const patterns of [
      QUOTA_STDERR_PATTERNS,
      AUTH_STDERR_PATTERNS,
      MODEL_NOT_FOUND_STDERR_PATTERNS
    ]) {
      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns.length).toBeGreaterThanOrEqual(2);
      for (const pattern of patterns) expect(pattern).toBeInstanceOf(RegExp);
    }
  });
});

describe("failure schemas", () => {
  it("FailureClassSchema accepts exactly the eight planned classes", () => {
    const classes = [
      "quota",
      "auth",
      "model_not_found",
      "timeout",
      "transport",
      "invalid_output",
      "cancelled",
      "unknown"
    ];
    for (const value of classes) {
      expect(FailureClassSchema.parse(value)).toBe(value);
    }
    expect(FailureClassSchema.safeParse("retryable").success).toBe(false);
  });

  it("FailureEvidenceSchema validates a complete evidence record", () => {
    const evidence = FailureEvidenceSchema.parse({
      failure_class: "quota",
      provider_code: "PROVIDER_EXIT_FAILED",
      exit_code: 1,
      stdout_hash: HASH_A,
      stderr_hash: HASH_B,
      attempt: 1,
      classified_by: "pattern"
    });
    expect(evidence.failure_class).toBe("quota");
  });

  it("FailureEvidenceSchema rejects bad attempts, hashes, and classifiers", () => {
    const base = {
      failure_class: "unknown",
      attempt: 1,
      classified_by: "default"
    };
    expect(FailureEvidenceSchema.safeParse({ ...base, attempt: 0 }).success).toBe(false);
    expect(FailureEvidenceSchema.safeParse({ ...base, attempt: 1.5 }).success).toBe(false);
    expect(
      FailureEvidenceSchema.safeParse({ ...base, stderr_hash: "not-a-hash" }).success
    ).toBe(false);
    expect(
      FailureEvidenceSchema.safeParse({ ...base, classified_by: "guessed" }).success
    ).toBe(false);
    expect(
      FailureEvidenceSchema.safeParse({ ...base, stderr_excerpt: "raw text" }).success
    ).toBe(false);
  });
});

describe("RetryPolicySchema", () => {
  it("applies the planned defaults", () => {
    const policy = RetryPolicySchema.parse({});
    expect(policy).toEqual({
      max_transport_retries: 1,
      allow_invalid_output_repair: false,
      backoff_ms: [500]
    });
  });

  it("bounds max_transport_retries to the 0-2 range and requires integers", () => {
    expect(RetryPolicySchema.safeParse({ max_transport_retries: 3 }).success).toBe(false);
    expect(RetryPolicySchema.safeParse({ max_transport_retries: -1 }).success).toBe(false);
    expect(RetryPolicySchema.safeParse({ max_transport_retries: 1.5 }).success).toBe(false);
    expect(RetryPolicySchema.parse({ max_transport_retries: 0 }).max_transport_retries).toBe(0);
    expect(RetryPolicySchema.parse({ max_transport_retries: 2 }).max_transport_retries).toBe(2);
  });

  it("rejects an empty backoff array and unknown keys", () => {
    expect(RetryPolicySchema.safeParse({ backoff_ms: [] }).success).toBe(false);
    expect(RetryPolicySchema.safeParse({ backoff_ms: [100.5] }).success).toBe(false);
    expect(RetryPolicySchema.safeParse({ jitter: true }).success).toBe(false);
  });

  it("caps each backoff value and the backoff array length", () => {
    expect(RetryPolicySchema.safeParse({ backoff_ms: [600_001] }).success).toBe(false);
    expect(RetryPolicySchema.safeParse({ backoff_ms: [-1] }).success).toBe(false);
    expect(
      RetryPolicySchema.safeParse({ backoff_ms: new Array(9).fill(100) }).success
    ).toBe(false);
    expect(RetryPolicySchema.parse({ backoff_ms: [600_000] }).backoff_ms).toEqual([
      600_000
    ]);
  });
});

describe("decideRetry", () => {
  const permissivePolicy: RetryPolicy = RetryPolicySchema.parse({
    max_transport_retries: 2,
    allow_invalid_output_repair: true,
    backoff_ms: [100, 200]
  });

  it("never retries quota, auth, model_not_found, cancelled, or timeout", () => {
    const terminalClasses: FailureClass[] = [
      "quota",
      "auth",
      "model_not_found",
      "cancelled",
      "timeout"
    ];
    for (const failure of terminalClasses) {
      // Even the most permissive policy and the first attempt must not retry.
      const decision = decideRetry(failure, 1, permissivePolicy);
      expect(decision.retry, failure).toBe(false);
      expect(decision.reason).toContain(failure);
      expect(decision.backoff_ms).toBeUndefined();
      expect(decision.repair_attempt).toBeUndefined();
    }
  });

  it("never retries unknown failures", () => {
    const decision = decideRetry("unknown", 1, permissivePolicy);
    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain("unknown");
  });

  it("retries transport failures while attempts remain, with backoff", () => {
    const first = decideRetry("transport", 1, permissivePolicy);
    expect(first).toMatchObject({ retry: true, backoff_ms: 100 });
    const second = decideRetry("transport", 2, permissivePolicy);
    expect(second).toMatchObject({ retry: true, backoff_ms: 200 });
    const third = decideRetry("transport", 3, permissivePolicy);
    expect(third.retry).toBe(false);
    expect(third.backoff_ms).toBeUndefined();
  });

  it("stops transport retries at max_transport_retries 0 and clamps backoff to the last value", () => {
    const zeroRetries = RetryPolicySchema.parse({ max_transport_retries: 0 });
    expect(decideRetry("transport", 1, zeroRetries).retry).toBe(false);

    const shortBackoff = RetryPolicySchema.parse({
      max_transport_retries: 2,
      backoff_ms: [100]
    });
    // The second retry has no dedicated slot in backoff_ms, so it reuses the
    // final configured value instead of failing or returning undefined.
    expect(decideRetry("transport", 2, shortBackoff)).toMatchObject({
      retry: true,
      backoff_ms: 100
    });
  });

  it("allows exactly one invalid_output repair, and only when explicitly enabled", () => {
    const defaultPolicy = RetryPolicySchema.parse({});
    expect(decideRetry("invalid_output", 1, defaultPolicy).retry).toBe(false);

    const first = decideRetry("invalid_output", 1, permissivePolicy);
    expect(first.retry).toBe(true);
    expect(first.repair_attempt).toBe(true);

    const second = decideRetry("invalid_output", 2, permissivePolicy);
    expect(second.retry).toBe(false);
    expect(second.repair_attempt).toBeUndefined();
  });

  it("rejects a non-positive or fractional attempt number with INVALID_RETRY_ATTEMPT", () => {
    for (const attempt of [0, -1, 1.5]) {
      try {
        decideRetry("transport", attempt, permissivePolicy);
        expect.unreachable(`decideRetry accepted attempt ${attempt}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ResearchStewardError);
        expect((error as ResearchStewardError).code).toBe("INVALID_RETRY_ATTEMPT");
      }
    }
  });
});

describe("invocation budget", () => {
  it("throws INVOCATION_BUDGET_EXCEEDED when planned attempts exceed the forecast", () => {
    try {
      assertInvocationBudget(5, 4);
      expect.unreachable("assertInvocationBudget should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchStewardError);
      expect((error as ResearchStewardError).code).toBe("INVOCATION_BUDGET_EXCEEDED");
    }
    expect(() => assertInvocationBudget(4, 4)).not.toThrow();
    expect(() => assertInvocationBudget(0, 0)).not.toThrow();
  });

  it("keeps every decideRetry sequence within the exact maxAttemptsFor bound", () => {
    // The plan's retry_limit + 1 (the dry-run forecast's attemptsPerNode) is
    // the authoritative per-node call bound. Derive the policy through
    // policyFromPlanLimits at the widest limits and verify by exhaustive
    // enumeration that no failure sequence can spend more calls than
    // maxAttemptsFor, which itself sits at or under retry_limit + 1.
    const retryLimit = 2;
    const policy = policyFromPlanLimits(retryLimit, { allowRepair: true });
    const bound = maxAttemptsFor(policy);
    expect(bound).toBeLessThanOrEqual(retryLimit + 1);

    const classes: FailureClass[] = [
      "quota",
      "auth",
      "model_not_found",
      "timeout",
      "transport",
      "invalid_output",
      "cancelled",
      "unknown"
    ];

    // Enumerate every failure sequence one entry longer than the bound, so
    // an off-by-one retry approval would be caught rather than truncated.
    const sequences: FailureClass[][] = [];
    const extend = (prefix: FailureClass[]): void => {
      if (prefix.length > 0) sequences.push(prefix);
      if (prefix.length > bound) return;
      for (const failure of classes) extend([...prefix, failure]);
    };
    extend([]);

    let deepestRun = 0;
    for (const sequence of sequences) {
      let attempts = 0;
      for (let index = 0; index < sequence.length; index += 1) {
        attempts += 1;
        const decision = decideRetry(sequence[index]!, attempts, policy);
        if (!decision.retry) break;
        // The retry was approved; if the sequence has no further failure the
        // next call succeeds and still costs one invocation.
        if (index === sequence.length - 1) attempts += 1;
      }
      deepestRun = Math.max(deepestRun, attempts);
      expect(attempts, sequence.join("→")).toBeLessThanOrEqual(bound);
      expect(() => assertInvocationBudget(attempts, bound)).not.toThrow();
      expect(() => assertInvocationBudget(attempts, retryLimit + 1)).not.toThrow();
    }
    // The bound is exact, not merely safe: some sequence actually reaches it.
    expect(deepestRun).toBe(bound);
  });

  it("rejects malformed budget inputs with INVALID_INVOCATION_BUDGET_INPUT", () => {
    const malformed: Array<[number, number]> = [
      [-1, 4],
      [1.5, 4],
      [1, -1],
      [1, 2.5]
    ];
    for (const [planned, forecast] of malformed) {
      try {
        assertInvocationBudget(planned, forecast);
        expect.unreachable(`accepted (${planned}, ${forecast})`);
      } catch (error) {
        expect(error).toBeInstanceOf(ResearchStewardError);
        expect((error as ResearchStewardError).code).toBe(
          "INVALID_INVOCATION_BUDGET_INPUT"
        );
      }
    }
  });
});

describe("plan limits alignment", () => {
  it("maxAttemptsFor is the exact supremum, with repair sharing the first retry slot", () => {
    expect(maxAttemptsFor(RetryPolicySchema.parse({}))).toBe(2);
    expect(maxAttemptsFor(RetryPolicySchema.parse({ max_transport_retries: 0 }))).toBe(1);
    expect(
      maxAttemptsFor(
        RetryPolicySchema.parse({
          max_transport_retries: 0,
          allow_invalid_output_repair: true
        })
      )
    ).toBe(2);
    expect(
      maxAttemptsFor(
        RetryPolicySchema.parse({
          max_transport_retries: 2,
          allow_invalid_output_repair: true
        })
      )
    ).toBe(3);
  });

  it("policyFromPlanLimits stays within retry_limit + 1 for every combination", () => {
    // Property over the full domain: retry_limit in {0,1,2} crossed with
    // allowRepair in {true,false}. The derived policy must be schema-valid
    // and its exact worst case must never exceed what the forecast priced.
    for (const retryLimit of [0, 1, 2] as const) {
      for (const allowRepair of [true, false]) {
        const policy = policyFromPlanLimits(retryLimit, { allowRepair });
        expect(RetryPolicySchema.parse(policy)).toEqual(policy);
        expect(policy.max_transport_retries).toBe(retryLimit);
        expect(policy.allow_invalid_output_repair).toBe(allowRepair && retryLimit >= 1);
        expect(policy.backoff_ms).toEqual([500]);
        expect(
          maxAttemptsFor(policy),
          `retry_limit=${retryLimit} allowRepair=${allowRepair}`
        ).toBeLessThanOrEqual(retryLimit + 1);
      }
    }
  });

  it("deliberately refuses repair when retry_limit is 0", () => {
    // A plan that budgeted exactly one call per node must not gain a second
    // "repair" call the forecast never priced.
    const policy = policyFromPlanLimits(0, { allowRepair: true });
    expect(policy.allow_invalid_output_repair).toBe(false);
    expect(maxAttemptsFor(policy)).toBe(1);
    expect(decideRetry("invalid_output", 1, policy).retry).toBe(false);
  });
});
