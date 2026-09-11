/**
 * Thin re-export: v2 command templates live in check-policy.ts (CR-M-064).
 * Delete this file after downstream imports migrate.
 */
export {
  ArgPatternSchema,
  CheckPolicyV2Schema,
  CommandTemplateSchema,
  ENV_DENYLIST_PREFIXES,
  assertEnvAllowed,
  authorizeTemplateRequest,
  isDenylistedEnvKey,
  matchArgPattern,
  type ArgPattern,
  type CheckPolicyV2,
  type CommandTemplate
} from "./check-policy.js";
