import path from "node:path";
import { z } from "zod";
import { ResearchStewardError } from "./utils.js";

/**
 * Policy for the deterministic check runner. Default-deny: executable must be
 * on the allowlist, network is off unless opted in, environment is minimal,
 * cwd is the project root. No shell string is ever accepted (Task 3.4).
 */

export const CheckPolicySchema = z
  .object({
    policy_version: z.literal(1),
    allowlist: z.array(z.string().min(1).max(200)).max(64),
    allow_network: z.boolean().default(false),
    max_wall_time_ms: z.number().int().min(100).max(600_000).default(30_000),
    max_output_bytes: z.number().int().min(1_024).max(10_000_000).default(1_000_000),
    max_concurrency: z.number().int().min(1).max(16).default(2),
    allowed_env: z.array(z.string().min(1).max(100)).max(32).default([]),
    extra_cwd_roots: z.array(z.string().min(1).max(4_096)).max(16).default([])
  })
  .strict();

export type CheckPolicy = z.infer<typeof CheckPolicySchema>;

export const CheckRequestSchema = z
  .object({
    executable: z.string().min(1).max(200),
    argv: z.array(z.string().max(2_000)).max(64),
    cwd: z.string().min(1).max(4_096).optional(),
    env: z.record(z.string().max(100), z.string().max(4_000)).optional(),
    timeout_ms: z.number().int().min(100).max(600_000).optional()
  })
  .strict();

export type CheckRequest = z.infer<typeof CheckRequestSchema>;

export const CheckResultSchema = z
  .object({
    check_version: z.literal(1),
    executable: z.string().min(1).max(200),
    argv: z.array(z.string().max(2_000)).max(64),
    cwd: z.string().min(1).max(4_096),
    exit_code: z.number().int(),
    signal: z.string().max(32).nullable(),
    timed_out: z.boolean(),
    stdout_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    stderr_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    stdout_chars: z.number().int().min(0),
    stderr_chars: z.number().int().min(0),
    truncated: z.boolean(),
    duration_ms: z.number().int().min(0),
    tool_version: z.string().max(200).optional()
  })
  .strict();

export type CheckResult = z.infer<typeof CheckResultSchema>;

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/**
 * Validate a request against policy without spawning. Never interpolates a
 * shell; argv is always an array.
 */
export function authorizeCheckRequest(
  policy: CheckPolicy,
  request: CheckRequest,
  projectRoot: string,
  realpathOf: (p: string) => string
): void {
  if (!policy.allowlist.includes(request.executable)) {
    throw new ResearchStewardError(
      "CHECK_EXECUTABLE_NOT_ALLOWED",
      `Executable is not on the project check allowlist.`,
      { executable: request.executable }
    );
  }
  for (const arg of request.argv) {
    if (arg.includes("\0")) {
      throw new ResearchStewardError(
        "CHECK_ARGUMENT_INVALID",
        "argv entries must not contain NUL."
      );
    }
  }
  const cwd = request.cwd === undefined ? projectRoot : realpathOf(request.cwd);
  const allowedRoots = [realpathOf(projectRoot), ...policy.extra_cwd_roots.map(realpathOf)];
  if (!allowedRoots.some((root) => inside(root, cwd))) {
    throw new ResearchStewardError(
      "CHECK_CWD_OUTSIDE_ROOT",
      "cwd must live inside the project root or an extra_cwd_roots entry.",
      { cwd }
    );
  }
  if (request.env !== undefined) {
    for (const key of Object.keys(request.env)) {
      if (!policy.allowed_env.includes(key)) {
        throw new ResearchStewardError(
          "CHECK_ENV_NOT_ALLOWED",
          `Environment variable is not on the policy allowed_env list.`,
          { key }
        );
      }
    }
  }
  if (request.timeout_ms !== undefined && request.timeout_ms > policy.max_wall_time_ms) {
    throw new ResearchStewardError(
      "CHECK_TIMEOUT_EXCEEDS_POLICY",
      "Requested timeout exceeds policy.max_wall_time_ms."
    );
  }
}

export function defaultCheckPolicy(allowlist: readonly string[]): CheckPolicy {
  return CheckPolicySchema.parse({ policy_version: 1, allowlist: [...allowlist] });
}
