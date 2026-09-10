/**
 * Roundtable planner for v0.2 (Task 1.3).
 *
 * buildPlan() turns a preset plus a frozen packet id and optional overrides
 * into a RoundtablePlan and a WorkflowLock. It is a pure function: nothing is
 * written to disk here. writeLock() persists a lock with write-once (wx)
 * semantics via writeImmutableFile().
 */

import { rm, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { validateGraph } from "./workflow.js";
import {
  RoundtablePlanSchema,
  type RoundtableNode,
  type RoundtablePlan
} from "./protocol.js";
import {
  ResearchStewardError,
  errorMessage,
  sha256Text,
  stableJson,
  writeImmutableFile
} from "./utils.js";
import {
  BUILT_IN_SKILL_IDS,
  PRESETS,
  type RoundtablePreset
} from "./presets.js";

export const PLANNER_GENERATOR_VERSION = "planner/0.2.0" as const;

const AdapterSchema = z.enum(["kimi", "qoder", "grok", "fake"]);
const ModeSchema = z.enum(["open", "blind", "mixed"]);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PacketIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

export const ProviderRouteSchema = z
  .object({
    adapter: AdapterSchema,
    model: z.string().min(1).max(100).optional(),
    route: z.enum(["subscription_cli", "fake"])
  })
  .strict();

export const WorkflowLockSchema = z
  .object({
    lock_version: z.literal(1),
    created_at: z.string().datetime({ offset: true }),
    plan_hash: HashSchema,
    preset_id: z.string().min(1).max(64),
    preset_version: z.string().regex(/^\d+\.\d+\.\d+$/),
    generator_version: z.literal(PLANNER_GENERATOR_VERSION),
    packet_id: PacketIdSchema,
    provider_routes: z.record(z.string(), ProviderRouteSchema),
    skill_ids: z.array(z.string().min(1).max(64)).max(64),
    // Reproducibility identity (RS-V1-SUP-007): freeze the budget/limits the
    // plan was built under, and skill fingerprints when available. Skills
    // currently have no version field in SKILL.md frontmatter; until Task 5.6
    // catalog lands, fingerprints are empty and the gap is declared.
    limits_fingerprint: HashSchema,
    skill_fingerprints: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            version: z.string().min(1).max(32).optional(),
            content_sha256: HashSchema.optional()
          })
          .strict()
      )
      .max(64),
    capability_gaps: z.array(z.string().min(1).max(2_000)).max(64)
  })
  .strict();

export type WorkflowLock = z.infer<typeof WorkflowLockSchema>;
export type ProviderRoute = z.infer<typeof ProviderRouteSchema>;

/**
 * Only fields that legitimately change the protocol-level plan can be
 * overridden: mode, per-node adapters/models/briefs, and the limits block.
 * Everything else (node topology, visibility, blind groups, adjudication
 * rights) is fixed by the preset. Unknown fields and unknown node ids are
 * rejected.
 */
const LimitsOverrideSchema = z
  .object({
    max_parallel: z.number().int().min(1).max(8),
    max_wall_time_ms: z.number().int().min(1_000).max(7_200_000),
    max_prompt_chars: z.number().int().min(1_000).max(500_000),
    max_output_chars: z.number().int().min(1_000).max(200_000),
    retry_limit: z.number().int().min(0).max(2),
    max_failures: z.number().int().min(0).max(32)
  })
  .partial()
  .strict();

const OverridesSchema = z
  .object({
    mode: ModeSchema.optional(),
    adapters: z.record(z.string().min(1).max(64), AdapterSchema).optional(),
    models: z.record(z.string().min(1).max(64), z.string().min(1).max(100)).optional(),
    limits: LimitsOverrideSchema.optional(),
    briefs: z.record(z.string().min(1).max(64), z.string().min(1).max(20_000)).optional()
  })
  .strict();

const BuildPlanInputSchema = z
  .object({
    preset_id: z.string().min(1).max(64),
    packet_id: PacketIdSchema,
    overrides: OverridesSchema.optional()
  })
  .strict();

export type BuildPlanInput = z.input<typeof BuildPlanInputSchema>;
export type PlanOverrides = z.infer<typeof OverridesSchema>;

/**
 * Local structural validation for planner output.
 *
 * NOTE: this mirrors validateGraph() in src/workflow.ts line by line (same
 * checks, same error codes) because validateGraph is not exported today and
 * Task 1.3 must not touch existing files. When the controller wires the
 * planner into the CLI/server it will export validateGraph from workflow.ts
 * and replace this copy with that import, so the two can never drift.
 */
export function validatePlanStructure(plan: RoundtablePlan): void {
  // Wiring batch: delegate to the workflow scheduler's own exported graph
  // validator so planner-side structural rules can never drift from runtime
  // enforcement. The temporary local copy that existed while validateGraph
  // was unexported has been removed.
  validateGraph(plan);
}

function assertKnownNodeIds(
  preset: RoundtablePreset,
  overrides: PlanOverrides
): void {
  const knownIds = new Set(preset.nodes.map((node) => node.id));
  const records: Array<[string, Record<string, unknown> | undefined]> = [
    ["adapters", overrides.adapters],
    ["models", overrides.models],
    ["briefs", overrides.briefs]
  ];
  for (const [field, record] of records) {
    for (const nodeId of Object.keys(record ?? {})) {
      if (!knownIds.has(nodeId)) {
        throw new ResearchStewardError(
          "UNKNOWN_PLAN_NODE",
          `overrides.${field} names node "${nodeId}", which does not exist in preset ${preset.preset_id}.`,
          { preset_id: preset.preset_id, field, node_id: nodeId }
        );
      }
    }
  }
}

function instantiateNode(
  template: RoundtablePreset["nodes"][number],
  packetId: string,
  overrides: PlanOverrides
): RoundtableNode {
  const brief = (overrides.briefs?.[template.id] ?? template.brief).replaceAll(
    "{{packet_id}}",
    packetId
  );
  const model = overrides.models?.[template.id];
  return {
    id: template.id,
    actor_id: template.actor_id,
    role: template.role,
    adapter: overrides.adapters?.[template.id] ?? template.adapter,
    brief,
    depends_on: [...template.depends_on],
    visibility: template.visibility,
    can_adjudicate: template.can_adjudicate,
    timeout_ms: template.timeout_ms,
    ...(template.blind_group !== undefined ? { blind_group: template.blind_group } : {}),
    ...(model !== undefined ? { model } : {})
  };
}

export function buildPlan(input: BuildPlanInput): { plan: RoundtablePlan; lock: WorkflowLock } {
  let parsed: z.infer<typeof BuildPlanInputSchema>;
  try {
    parsed = BuildPlanInputSchema.parse(input);
  } catch (error) {
    throw new ResearchStewardError(
      "INVALID_PLANNER_INPUT",
      `Planner input is invalid: ${errorMessage(error)}`
    );
  }

  const preset = PRESETS[parsed.preset_id];
  if (!preset) {
    throw new ResearchStewardError(
      "UNKNOWN_PRESET",
      `Unknown preset "${parsed.preset_id}". Available presets: ${Object.keys(PRESETS).join(", ")}.`
    );
  }
  const overrides = parsed.overrides ?? {};
  assertKnownNodeIds(preset, overrides);

  const candidate = {
    version: 1 as const,
    name: preset.title,
    packet_id: parsed.packet_id,
    mode: overrides.mode ?? preset.mode,
    limits: { ...preset.limits, ...overrides.limits },
    nodes: preset.nodes.map((template) => instantiateNode(template, parsed.packet_id, overrides))
  };

  let plan: RoundtablePlan;
  try {
    plan = RoundtablePlanSchema.parse(candidate);
  } catch (error) {
    throw new ResearchStewardError(
      "PRESET_PLAN_INVALID",
      `Preset ${preset.preset_id} produced a plan that fails RoundtablePlanSchema: ${errorMessage(error)}`
    );
  }
  validatePlanStructure(plan);

  const providerRoutes: Record<string, ProviderRoute> = {};
  const capabilityGaps: string[] = [];
  for (const node of plan.nodes) {
    providerRoutes[node.id] = {
      adapter: node.adapter,
      route: node.adapter === "fake" ? "fake" : "subscription_cli",
      ...(node.model !== undefined ? { model: node.model } : {})
    };
    if (node.adapter === "fake") {
      capabilityGaps.push(
        `Node "${node.id}" is routed to the fake adapter placeholder; bind a real subscription CLI adapter before a production run.`
      );
    }
  }

  const lock = WorkflowLockSchema.parse({
    lock_version: 1,
    created_at: new Date().toISOString(),
    plan_hash: sha256Text(stableJson(plan)),
    preset_id: preset.preset_id,
    preset_version: preset.preset_version,
    generator_version: PLANNER_GENERATOR_VERSION,
    packet_id: parsed.packet_id,
    provider_routes: providerRoutes,
    skill_ids: [...BUILT_IN_SKILL_IDS],
    limits_fingerprint: sha256Text(stableJson(plan.limits)),
    skill_fingerprints: BUILT_IN_SKILL_IDS.map((id) => ({ id })),
    capability_gaps: [
      ...capabilityGaps,
      "Skill SKILL.md files carry no version field yet; lock records skill ids only until the Task 5.6 catalog can supply versions and content hashes (RS-V1-SUP-007)."
    ]
  });

  return { plan, lock };
}

/**
 * Persist a lock with write-once semantics. writeImmutableFile opens the
 * destination with the "wx" flag, so an existing file makes this reject with
 * EEXIST instead of being overwritten.
 */
export async function writeLock(filePath: string, lock: WorkflowLock): Promise<void> {
  const validated = WorkflowLockSchema.parse(lock);
  await writeImmutableFile(filePath, `${JSON.stringify(validated, null, 2)}\n`);
}

/**
 * Persist a plan and its lock as one unit (RS-V1-SUP-011). Writing them as
 * two independent writeImmutableFile calls can leave a half-committed pair
 * when the second fails. This helper:
 *   1. rejects identical destinations (after resolve + parent realpath);
 *   2. writes the plan first;
 *   3. if the lock write fails, removes the plan it just created so the
 *      caller never sees a plan without its lock. If that rollback rm also
 *      fails, the leftover path is attached to the error details (CR-M-031).
 * Existing destinations are still never overwritten: the first EEXIST wins
 * and nothing is deleted that this call did not create.
 *
 * Deviation (CR-M-029): crash atomicity across two files is not implemented.
 * A process kill between the two writes can still leave a plan without a
 * lock. Codex asked for a recoverable transaction marker if full atomicity
 * is not done; that marker is deferred and recorded in the Task 1.3 milestone
 * for Codex adjudication.
 */
export async function writePlanAndLock(
  planPath: string,
  plan: RoundtablePlan,
  lockPath: string,
  lock: WorkflowLock
): Promise<void> {
  const canonicalPlan = await canonicalForCompare(planPath);
  const canonicalLock = await canonicalForCompare(lockPath);
  if (canonicalPlan === canonicalLock) {
    throw new ResearchStewardError(
      "PLAN_LOCK_PATH_COLLISION",
      "The plan and workflow lock must be written to different paths.",
      { plan_path: canonicalPlan, lock_path: canonicalLock }
    );
  }
  const planBody = `${JSON.stringify(RoundtablePlanSchema.parse(plan), null, 2)}\n`;
  const lockBody = `${JSON.stringify(WorkflowLockSchema.parse(lock), null, 2)}\n`;
  await writeImmutableFile(planPath, planBody);
  try {
    await writeImmutableFile(lockPath, lockBody);
  } catch (error) {
    let leftover: string | null = null;
    try {
      await rm(planPath, { force: true });
    } catch {
      leftover = planPath;
    }
    if (leftover !== null) {
      throw new ResearchStewardError(
        (error as { code?: string }).code === "EEXIST"
          ? "EEXIST"
          : "PLAN_LOCK_ROLLBACK_FAILED",
        `${(error as Error).message} (rollback could not remove ${leftover})`,
        {
          cause_code: (error as NodeJS.ErrnoException).code,
          leftover_plan_path: leftover
        }
      );
    }
    throw error;
  }
}

async function canonicalForCompare(candidate: string): Promise<string> {
  const resolved = path.resolve(candidate);
  try {
    return path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}
