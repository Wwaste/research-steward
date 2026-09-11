import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { z } from "zod";
import { ResearchStewardError } from "./utils.js";

/**
 * Policy for the deterministic check runner. Default-deny: executable must be
 * on the allowlist, network is off unless opted in, environment is minimal,
 * cwd is the project root. No shell string is ever accepted (Task 3.4).
 */

export const CheckPolicyV1Schema = z
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

export type CheckPolicyV1 = z.infer<typeof CheckPolicyV1Schema>;
export type CheckPolicy = CheckPolicyV1;
export const CheckPolicySchema = CheckPolicyV1Schema; // runner keeps v1 shape

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


// --- v2 command templates (DESIGN-COMMAND-DOMAIN / CR-M-064) ---

export const ArgPatternSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string().max(2_000) }).strict(),
  z
    .object({
      kind: z.literal("enum"),
      values: z.array(z.string().max(200)).min(1).max(32)
    })
    .strict(),
  z
    .object({
      kind: z.literal("path"),
      within: z.enum(["project_root", "extra_root"])
    })
    .strict(),
  z.object({ kind: z.literal("regex"), pattern: z.string().max(500) })
    .strict()
    .refine(
      (v) => {
        try {
          new RegExp(v.pattern);
        } catch {
          return false;
        }
        if (/\([^)]*[+*][^)]*\)[+*]/.test(v.pattern)) return false;
        return true;
      },
      { message: "regex must compile and must not contain nested quantifiers" }
    )
]);

export type ArgPattern = z.infer<typeof ArgPatternSchema>;

export const CommandTemplateSchema = z
  .object({
    template_id: z.string().min(1).max(100),
    executable: z.string().min(1).max(4_096),
    argv_pattern: z.array(ArgPatternSchema).max(64),
    allow_trailing: ArgPatternSchema.optional(),
    allow_network: z.boolean().default(false),
    max_wall_time_ms: z.number().int().min(100).max(600_000).optional()
  })
  .strict();

export type CommandTemplate = z.infer<typeof CommandTemplateSchema>;

export const CheckPolicyV2Schema = z
  .object({
    policy_version: z.literal(2),
    templates: z.array(CommandTemplateSchema).max(64),
    path_dirs: z.array(z.string().max(4_096)).max(16).default([]),
    network_enforcement: z.enum(["best_effort", "required"]).default("best_effort"),
    max_wall_time_ms: z.number().int().min(100).max(600_000).default(30_000),
    max_output_bytes: z.number().int().min(1_024).max(10_000_000).default(1_000_000),
    max_concurrency: z.number().int().min(1).max(16).default(2),
    allowed_env: z.array(z.string().min(1).max(100)).max(32).default([]),
    extra_cwd_roots: z.array(z.string().min(1).max(4_096)).max(16).default([])
  })
  .strict();

export type CheckPolicyV2 = z.infer<typeof CheckPolicyV2Schema>;

export const CheckPolicyAnySchema = z.discriminatedUnion("policy_version", [
  CheckPolicyV1Schema,
  CheckPolicyV2Schema
]);
export type CheckPolicyAny = z.infer<typeof CheckPolicyAnySchema>;

export const ENV_DENYLIST_PREFIXES = [
  "LD_",
  "DYLD_",
  "NODE_OPTIONS",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONHOME",
  "PERL5LIB",
  "RUBYOPT",
  "BASH_ENV",
  "ENV",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND"
] as const;

export function isDenylistedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return ENV_DENYLIST_PREFIXES.some(
    (prefix) => upper === prefix.toUpperCase() || upper.startsWith(prefix.toUpperCase())
  );
}

export function matchArgPattern(
  pattern: ArgPattern,
  value: string,
  projectRoot: string
): boolean {
  switch (pattern.kind) {
    case "literal":
      return value === pattern.value;
    case "enum":
      return pattern.values.includes(value);
    case "path": {
      if (value.includes("\0")) return false;
      if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
      if (value.split(/[\\/]/).includes("..")) return false;
      // CR-M-064: realpath + inside() so symlink parents cannot escape.
      try {
        const resolved = path.resolve(projectRoot, value);
        const relative = path.relative(projectRoot, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
        const realRoot = realpathSync(projectRoot);
        // realpath deepest existing ancestor; re-append missing tail.
        // CR-M-080: reject any symlink among existing ancestors or the leaf.
        const realRoot = realpathSync(projectRoot);
        let current = resolved;
        for (;;) {
          try {
            const st = lstatSync(current);
            if (st.isSymbolicLink()) return false;
            const real = realpathSync(current);
            const realRel = path.relative(realRoot, real);
            if (realRel.startsWith("..") || path.isAbsolute(realRel)) return false;
            break;
          } catch {
            const parent = path.dirname(current);
            if (parent === current) return false;
            current = parent;
          }
        }
      } catch {
        return false;
      }
      return true;
    }
    case "regex": {
      if (pattern.pattern.length > 500) return false;
      // Conservative: reject nested quantifiers that enable catastrophic backtracking.
      if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern.pattern)) return false;
      try {
        return new RegExp(pattern.pattern).test(value);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

export function authorizeTemplateRequest(
  policy: CheckPolicyV2,
  request: { template_id: string; argv: readonly string[] },
  projectRoot: string
): CommandTemplate {
  const template = policy.templates.find((t) => t.template_id === request.template_id);
  if (!template) {
    throw new ResearchStewardError(
      "CHECK_TEMPLATE_MISMATCH",
      "No command template matches the request.",
      { template_id: request.template_id }
    );
  }
  const patterns = template.argv_pattern;
  if (request.argv.length < patterns.length) {
    throw new ResearchStewardError(
      "CHECK_TEMPLATE_MISMATCH",
      "argv is shorter than the template pattern.",
      { template_id: request.template_id }
    );
  }
  for (let i = 0; i < patterns.length; i += 1) {
    if (!matchArgPattern(patterns[i]!, request.argv[i]!, projectRoot)) {
      throw new ResearchStewardError(
        "CHECK_TEMPLATE_MISMATCH",
        `argv[${i}] does not match the template pattern.`,
        { template_id: request.template_id, index: i }
      );
    }
  }
  if (request.argv.length > patterns.length) {
    if (!template.allow_trailing) {
      throw new ResearchStewardError(
        "CHECK_TEMPLATE_MISMATCH",
        "Trailing argv is not allowed for this template.",
        { template_id: request.template_id }
      );
    }
    for (const extra of request.argv.slice(patterns.length)) {
      if (!matchArgPattern(template.allow_trailing, extra, projectRoot)) {
        throw new ResearchStewardError(
          "CHECK_TEMPLATE_MISMATCH",
          "A trailing argument does not match allow_trailing.",
          { template_id: request.template_id }
        );
      }
    }
  }
  return template;
}

export function assertEnvAllowed(policy: CheckPolicyV2, key: string): void {
  if (isDenylistedEnvKey(key)) {
    throw new ResearchStewardError(
      "CHECK_ENV_DENYLISTED",
      `Environment variable ${key} is denylisted for command execution.`,
      { key }
    );
  }
  if (!policy.allowed_env.includes(key)) {
    throw new ResearchStewardError(
      "CHECK_ENV_NOT_ALLOWED",
      `Environment variable ${key} is not on allowed_env.`,
      { key }
    );
  }
}


/** CR-M-064: resolve a bare executable name only inside path_dirs. */
export async function resolveExecutableInPathDirs(
  policy: CheckPolicyV2,
  name: string
): Promise<string> {
  if (name.includes("/") || name.includes("\\")) {
    throw new ResearchStewardError(
      "CHECK_EXECUTABLE_UNRESOLVED",
      "Bare executable names only; use templates for absolute paths."
    );
  }
  const { access, realpath } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  for (const dir of policy.path_dirs) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // try next
    }
  }
  throw new ResearchStewardError(
    "CHECK_EXECUTABLE_UNRESOLVED",
    "Executable not found in path_dirs.",
    { name }
  );
}

/** CR-M-064: extra_cwd_roots tolerate missing roots (skip, do not throw). */
export async function usableExtraCwdRoots(
  policy: CheckPolicyV2
): Promise<string[]> {
  const { realpath } = await import("node:fs/promises");
  const out: string[] = [];
  for (const root of policy.extra_cwd_roots) {
    try {
      out.push(await realpath(root));
    } catch {
      // skip missing
    }
  }
  return out;
}


/** CR-M-082: single production entry for v1/v2 policy documents. */
export function loadCheckPolicy(raw: unknown): CheckPolicyAny {
  return CheckPolicyAnySchema.parse(raw);
}
