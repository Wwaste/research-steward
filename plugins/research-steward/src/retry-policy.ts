import { z } from "zod";
import type { FailureClass } from "./provider-failure.js";
import { ResearchStewardError } from "./utils.js";

/**
 * Bounded retry policy for provider invocations. The bounds are deliberately
 * tight: at most two transport retries, at most one repair attempt for
 * invalid output, and repair is off unless a plan opts in. Because a repair
 * can only start from attempt 1, it consumes the same first retry slot a
 * transport failure would; the exact per-node worst case under decideRetry is
 * therefore maxAttemptsFor(policy) = 1 + max(max_transport_retries,
 * allow_invalid_output_repair ? 1 : 0), not an additive 1 + retries + repair.
 * policyFromPlanLimits keeps that value within the forecast's authoritative
 * retry_limit + 1 bound.
 */
export const RetryPolicySchema = z
  .object({
    max_transport_retries: z.number().int().min(0).max(2).default(1),
    allow_invalid_output_repair: z.boolean().default(false),
    backoff_ms: z
      .array(z.number().int().min(0).max(600_000))
      .min(1)
      .max(8)
      .default([500])
  })
  .strict();

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * Exact reachable supremum of provider calls for one node under decideRetry.
 * A repair attempt is only granted at attempt 1, so repair and the first
 * transport retry compete for the same slot instead of stacking; the longest
 * possible chain is one initial call followed by max(max_transport_retries,
 * repair-enabled ? 1 : 0) further calls.
 */
export function maxAttemptsFor(policy: RetryPolicy): number {
  return (
    1 +
    Math.max(
      policy.max_transport_retries,
      policy.allow_invalid_output_repair ? 1 : 0
    )
  );
}

/**
 * Derives a retry policy from a plan's limits.retry_limit (0-2, the same
 * field the dry-run forecast prices as retry_limit + 1 calls per node, which
 * is the authoritative per-node upper bound). The mapping guarantees
 * maxAttemptsFor(policy) <= retry_limit + 1 for every combination, so
 * assertInvocationBudget can never conflict with an approved forecast:
 * transport retries take the full retry_limit, and repair is enabled only
 * when the caller asked for it AND retry_limit >= 1. Disabling repair at
 * retry_limit 0 is deliberate - a plan that budgeted exactly one call per
 * node must not gain a second "repair" call the forecast never priced.
 */
export function policyFromPlanLimits(
  retry_limit: 0 | 1 | 2,
  options: { allowRepair?: boolean } = {}
): RetryPolicy {
  if (![0, 1, 2].includes(retry_limit)) {
    throw new ResearchStewardError(
      "INVALID_RETRY_LIMIT",
      `policyFromPlanLimits requires a retry_limit of 0, 1, or 2; received ${retry_limit}.`
    );
  }
  return RetryPolicySchema.parse({
    max_transport_retries: retry_limit,
    allow_invalid_output_repair: options.allowRepair === true && retry_limit >= 1,
    backoff_ms: [500]
  });
}

export interface RetryDecision {
  retry: boolean;
  reason: string;
  backoff_ms?: number;
  repair_attempt?: boolean;
}

/**
 * Decides whether one more provider call is justified after a classified
 * failure. `attempt` is the 1-based number of the call that just failed.
 *
 * The rules are fixed by the v0.2 plan:
 * - quota, auth, model_not_found, cancelled, and timeout never retry, since
 *   another identical call cannot succeed or would double a bounded cost;
 * - transport failures retry while attempt <= max_transport_retries, with a
 *   backoff drawn from backoff_ms (the last value repeats when the array is
 *   shorter than the retry sequence);
 * - invalid_output allows a single repair attempt, only when the policy has
 *   allow_invalid_output_repair enabled and only after the first attempt;
 * - unknown failures never retry, because an unclassified error gives no
 *   grounds to believe a second call is safe to pay for.
 */
export function decideRetry(
  failure: FailureClass,
  attempt: number,
  policy: RetryPolicy
): RetryDecision {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new ResearchStewardError(
      "INVALID_RETRY_ATTEMPT",
      `Retry decisions require a 1-based integer attempt number; received ${attempt}.`
    );
  }

  switch (failure) {
    case "quota":
    case "auth":
    case "model_not_found":
    case "cancelled":
    case "timeout":
      return {
        retry: false,
        reason:
          `The failure class "${failure}" is not retryable: repeating the call ` +
          "cannot fix the underlying condition and would only spend more budget."
      };
    case "transport": {
      if (attempt <= policy.max_transport_retries) {
        const index = Math.min(attempt - 1, policy.backoff_ms.length - 1);
        return {
          retry: true,
          reason:
            `Transport failure on attempt ${attempt} is within the policy limit ` +
            `of ${policy.max_transport_retries} transport retries.`,
          backoff_ms: policy.backoff_ms[index]!
        };
      }
      return {
        retry: false,
        reason:
          `Transport failure on attempt ${attempt} exhausted the policy limit ` +
          `of ${policy.max_transport_retries} transport retries.`
      };
    }
    case "invalid_output": {
      if (policy.allow_invalid_output_repair && attempt === 1) {
        return {
          retry: true,
          reason:
            "Invalid output on the first attempt qualifies for the single " +
            "repair attempt this policy explicitly enables.",
          repair_attempt: true
        };
      }
      return {
        retry: false,
        reason: policy.allow_invalid_output_repair
          ? `Invalid output on attempt ${attempt} is past the single allowed repair attempt.`
          : "Invalid output is not retried because this policy does not enable repair attempts."
      };
    }
    case "unknown":
      return {
        retry: false,
        reason:
          'The failure class "unknown" is not retryable: without a classified ' +
          "cause there is no basis for paying for another call."
      };
  }
}

/**
 * Guards the runtime against exceeding the dry-run forecast. The forecast
 * (Task 1.4) computes a worst-case invocation count before any model starts;
 * a caller about to make plannedAttempts calls for a node must stay at or
 * under that bound, otherwise the run stops loudly instead of silently
 * spending beyond what the human approved.
 */
export function assertInvocationBudget(
  plannedAttempts: number,
  forecastWorstCase: number
): void {
  if (!Number.isInteger(plannedAttempts) || plannedAttempts < 0) {
    throw new ResearchStewardError(
      "INVALID_INVOCATION_BUDGET_INPUT",
      `plannedAttempts must be a non-negative integer; received ${plannedAttempts}.`
    );
  }
  if (!Number.isInteger(forecastWorstCase) || forecastWorstCase < 0) {
    throw new ResearchStewardError(
      "INVALID_INVOCATION_BUDGET_INPUT",
      `forecastWorstCase must be a non-negative integer; received ${forecastWorstCase}.`
    );
  }
  if (plannedAttempts > forecastWorstCase) {
    throw new ResearchStewardError(
      "INVOCATION_BUDGET_EXCEEDED",
      `Planned ${plannedAttempts} provider attempt(s), but the dry-run forecast ` +
        `bounds this work at ${forecastWorstCase}. Refusing to exceed the approved budget.`,
      { planned_attempts: plannedAttempts, forecast_worst_case: forecastWorstCase }
    );
  }
}
