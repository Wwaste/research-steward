import { z } from "zod";
import { ResearchStewardError } from "./utils.js";

/**
 * Command domain policy v2 (DESIGN-COMMAND-DOMAIN). v1 allowlist policies
 * remain parseable; v2 matches argv against command templates.
 */

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
  z.object({ kind: z.literal("regex"), pattern: z.string().max(500) }).strict()
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
      // Conservative: reject absolute escapes and parent traversal.
      if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
      if (value.split(/[\\/]/).includes("..")) return false;
      void projectRoot;
      return true;
    }
    case "regex": {
      if (pattern.pattern.length > 500) return false;
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
