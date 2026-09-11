import path from "node:path";
import {
  authorizeTemplateRequest,
  assertEnvAllowed,
  type CheckPolicyV2,
  type CommandTemplate
} from "./command-policy.js";
import { prepareAndRunCheck, type CheckResult } from "./check-runner.js";
import { ResearchStewardError, sha256Text, stableJson } from "./utils.js";

/**
 * Check execution domain (DESIGN-COMMAND-DOMAIN). One of the only two spawn
 * call sites in the plugin (providers.ts + here). Returns hashed evidence
 * only — never raw stdout/stderr to the caller.
 */

export interface PolicyCheckRequest {
  template_id: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
}

export interface PolicyCheckEvidence {
  check_version: 1;
  template_id: string;
  executable: string;
  argv: string[];
  command_line_sha256: string;
  exit_code: number;
  timed_out: boolean;
  stdout_sha256: string;
  stderr_sha256: string;
  duration_ms: number;
  network_enforcement: "best_effort" | "required" | "sandboxed";
}

export interface CheckDomain {
  runPolicyCheck(
    request: PolicyCheckRequest,
    opts?: { signal?: AbortSignal }
  ): Promise<PolicyCheckEvidence>;
}

function commandLineHash(input: {
  executable: string;
  argv: readonly string[];
  cwd_rel: string;
  env_overrides: Record<string, string>;
}): string {
  return sha256Text(
    stableJson({
      executable_resolved: input.executable,
      argv: input.argv,
      cwd_rel: input.cwd_rel,
      env_overrides: input.env_overrides
    })
  );
}

export function createCheckDomain(
  projectRoot: string,
  policy: CheckPolicyV2
): CheckDomain {
  return {
    async runPolicyCheck(request, opts) {
      const template: CommandTemplate = authorizeTemplateRequest(policy, request, projectRoot);
      for (const key of Object.keys(request.env ?? {})) {
        assertEnvAllowed(policy, key);
      }
      const timeoutMs = Math.min(
        request.timeout_ms ?? template.max_wall_time_ms ?? policy.max_wall_time_ms,
        policy.max_wall_time_ms
      );

      // Bridge to the existing check-runner for the actual spawn (process
      // group + wall clock). Template executable is the only allowed binary.
      const result: CheckResult = await prepareAndRunCheck({
        projectRoot,
        policy: {
          policy_version: 1,
          allowlist: [template.executable],
          allow_network: template.allow_network,
          max_wall_time_ms: timeoutMs,
          max_output_bytes: policy.max_output_bytes,
          max_concurrency: policy.max_concurrency,
          allowed_env: policy.allowed_env,
          extra_cwd_roots: policy.extra_cwd_roots
        },
        request: {
          executable: template.executable,
          argv: [...request.argv],
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          ...(request.env === undefined ? {} : { env: request.env }),
          timeout_ms: timeoutMs
        },
        ...(opts?.signal === undefined ? {} : { signal: opts.signal })
      });

      return {
        check_version: 1,
        template_id: request.template_id,
        executable: result.executable,
        argv: result.argv,
        command_line_sha256: commandLineHash({
          executable: result.executable,
          argv: result.argv,
          cwd_rel: path.relative(projectRoot, result.cwd) || ".",
          env_overrides: request.env ?? {}
        }),
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        stdout_sha256: result.stdout_sha256,
        stderr_sha256: result.stderr_sha256,
        duration_ms: result.duration_ms,
        network_enforcement: policy.network_enforcement
      };
    }
  };
}

