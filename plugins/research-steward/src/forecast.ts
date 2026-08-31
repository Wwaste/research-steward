import { z } from "zod";
import { RoundtablePlanSchema, type RoundtablePlan } from "./protocol.js";
import {
  ResearchStewardError,
  sha256Text,
  stableJson,
  writeImmutableFile
} from "./utils.js";

export const FORECAST_VERSION = 1 as const;

/**
 * A worst-case invocation budget above this size is worth a human look before
 * the run starts, even though nothing about it is invalid.
 */
export const LARGE_INVOCATION_BUDGET = 64;

export const ForecastWarningSchema = z
  .object({
    code: z.string().min(1).max(100),
    severity: z.enum(["info", "blocking"]),
    message: z.string().min(1).max(2_000)
  })
  .strict();

export type ForecastWarning = z.infer<typeof ForecastWarningSchema>;

const ProviderForecastSchema = z
  .object({
    nodes: z.number().int().min(1),
    worst_case_invocations: z.number().int().min(1),
    route: z.enum(["subscription_cli", "fake"])
  })
  .strict();

export const ForecastSchema = z
  .object({
    forecast_version: z.literal(FORECAST_VERSION),
    created_at: z.string().datetime({ offset: true }),
    plan_hash: z.string().regex(/^[a-f0-9]{64}$/),
    node_count: z.number().int().min(1).max(32),
    max_parallel_width: z.number().int().min(1).max(8),
    worst_case_invocations: z.number().int().min(0),
    fake_invocations: z.number().int().min(0),
    per_provider: z.record(z.string().min(1).max(50), ProviderForecastSchema),
    prompt_char_upper_bound: z.number().int().min(0),
    output_char_upper_bound: z.number().int().min(0),
    wall_time_upper_bound_ms: z.number().int().min(0),
    wall_time_bound_source: z.enum(["limits.max_wall_time_ms", "critical_path_estimate"]),
    warnings: z.array(ForecastWarningSchema).max(100)
  })
  .strict();

export type Forecast = z.infer<typeof ForecastSchema>;

/**
 * Routing classes the forecast already understands. The current adapter enum
 * only produces "subscription_cli" and "fake", but the warning logic below is
 * written against the full set so a future metered or unrecognized adapter is
 * flagged as blocking the moment it appears, instead of being silently priced
 * as a flat-rate subscription.
 */
export type ProviderRoute = "subscription_cli" | "metered_api" | "fake" | "unknown";

export function classifyRoute(adapter: string): ProviderRoute {
  switch (adapter) {
    case "fake":
      return "fake";
    case "kimi":
    case "qoder":
    case "grok":
      return "subscription_cli";
    default:
      return "unknown";
  }
}

/**
 * Warning generator for the route classes above. Under the current adapter
 * enum, buildForecast can never reach the blocking branch on its own:
 * RoundtablePlanSchema rejects any adapter outside kimi/qoder/grok/fake before
 * classification runs. The branch is therefore exercised by unit tests that
 * call this function directly with arbitrary adapter strings and routes, and
 * representableRoute below fails loud if the enum ever grows a route the
 * per_provider table cannot represent.
 */
export function routeWarning(
  adapter: string,
  route: ProviderRoute
): ForecastWarning | undefined {
  if (route !== "metered_api" && route !== "unknown") return undefined;
  return {
    code: "metered-or-unknown-route",
    severity: "blocking",
    message:
      `Adapter "${adapter}" resolves to the "${route}" route. The forecast cannot ` +
      "bound its cost as a flat-rate subscription call, so a human must review " +
      "this plan before any model is started."
  };
}

/**
 * Per_provider only ever represents routes the current adapter enum can
 * produce. If the enum grows an adapter that classifies as metered or unknown,
 * this fails loudly so ForecastSchema gets extended deliberately instead of
 * mislabeling the new route.
 */
function representableRoute(adapter: string): "subscription_cli" | "fake" {
  const route = classifyRoute(adapter);
  if (route === "subscription_cli" || route === "fake") return route;
  throw new ResearchStewardError(
    "UNREPRESENTABLE_ROUTE",
    `Adapter "${adapter}" classifies as "${route}", which the per_provider table cannot represent yet.`
  );
}

/**
 * Layers the DAG by dependency depth: a node's depth is one more than its
 * deepest dependency. This matches the workflow scheduler only while every
 * layer fits inside limits.max_parallel; a wider layer is split across several
 * batches, and batches may then mix nodes from different layers. Fails on
 * graphs the workflow would also refuse.
 */
function nodeDepths(plan: RoundtablePlan): Map<string, number> {
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  if (nodes.size !== plan.nodes.length) {
    throw new ResearchStewardError("DUPLICATE_NODE", "Roundtable node IDs must be unique.");
  }
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (nodeId: string): number => {
    const known = depths.get(nodeId);
    if (known !== undefined) return known;
    if (visiting.has(nodeId)) {
      throw new ResearchStewardError(
        "CYCLIC_PLAN",
        "Roundtable plan must be a directed acyclic graph."
      );
    }
    const node = nodes.get(nodeId);
    if (!node) {
      throw new ResearchStewardError(
        "UNKNOWN_DEPENDENCY",
        `Plan references unknown node ${nodeId}.`
      );
    }
    visiting.add(nodeId);
    let depth = 0;
    for (const dependency of node.depends_on) {
      depth = Math.max(depth, depthOf(dependency) + 1);
    }
    visiting.delete(nodeId);
    depths.set(nodeId, depth);
    return depth;
  };
  for (const node of plan.nodes) depthOf(node.id);
  return depths;
}

/**
 * Builds a pre-run resource forecast from a plan object alone. This is a pure
 * planning step: it never starts a provider, never appends an event, and never
 * touches the project workspace. It also never claims to know how much quota a
 * provider actually has left; every number here is derived from the plan and
 * its declared limits alone, and the wall-time figure is an upper bound only
 * because the workflow enforces its deadline as a hard stop.
 */
export function buildForecast(rawPlan: unknown): Forecast {
  const plan = RoundtablePlanSchema.parse(rawPlan);
  const depths = nodeDepths(plan);

  const layerSizes = new Map<number, number>();
  for (const depth of depths.values()) {
    layerSizes.set(depth, (layerSizes.get(depth) ?? 0) + 1);
  }
  const widestLayer = Math.max(...layerSizes.values());
  const criticalPathNodes = Math.max(...depths.values()) + 1;

  const attemptsPerNode = plan.limits.retry_limit + 1;
  const perProvider: Record<
    string,
    { nodes: number; worst_case_invocations: number; route: "subscription_cli" | "fake" }
  > = {};
  const warnings: ForecastWarning[] = [];
  const inspectedAdapters = new Set<string>();
  for (const node of plan.nodes) {
    if (!inspectedAdapters.has(node.adapter)) {
      inspectedAdapters.add(node.adapter);
      const warning = routeWarning(node.adapter, classifyRoute(node.adapter));
      if (warning) warnings.push(warning);
    }
    const entry = perProvider[node.adapter] ?? {
      nodes: 0,
      worst_case_invocations: 0,
      route: representableRoute(node.adapter)
    };
    entry.nodes += 1;
    entry.worst_case_invocations += attemptsPerNode;
    perProvider[node.adapter] = entry;
  }

  let worstCaseInvocations = 0;
  let fakeInvocations = 0;
  for (const entry of Object.values(perProvider)) {
    if (entry.route === "fake") fakeInvocations += entry.worst_case_invocations;
    else worstCaseInvocations += entry.worst_case_invocations;
  }

  // The threshold deliberately reads the paid worst case so the warning keeps
  // the same meaning as the worst_case_invocations field: a fake-only rehearsal
  // can be as large as it likes without tripping a budget review.
  if (worstCaseInvocations > LARGE_INVOCATION_BUDGET) {
    warnings.push({
      code: "large-invocation-budget",
      severity: "info",
      message:
        `This plan can invoke paid providers up to ${worstCaseInvocations} times ` +
        `(${attemptsPerNode} attempts per node), above the review threshold of ` +
        `${LARGE_INVOCATION_BUDGET}. Consider a smaller plan or a lower retry_limit.`
    });
  }

  // Wall-time bound. limits.max_wall_time_ms is always a true upper bound,
  // because the workflow enforces its persisted deadline as a hard stop: once
  // it passes, remaining nodes are committed as blocked without any provider
  // call. The tighter product criticalPathNodes x maxTimeout x attempts is
  // only valid while every layer fits inside max_parallel, since then each
  // scheduler batch is exactly one layer. A wider layer needs several batches,
  // and batches can then span layers, so we fall back to the deadline instead
  // of attempting a per-layer ceil-sum that would need its own justification.
  const everyLayerFitsOneBatch = widestLayer <= plan.limits.max_parallel;
  const maxNodeTimeoutMs = Math.max(...plan.nodes.map((node) => node.timeout_ms));
  const criticalPathEstimateMs = criticalPathNodes * maxNodeTimeoutMs * attemptsPerNode;
  const criticalPathWins =
    everyLayerFitsOneBatch && criticalPathEstimateMs < plan.limits.max_wall_time_ms;
  const wallTimeUpperBoundMs = criticalPathWins
    ? criticalPathEstimateMs
    : plan.limits.max_wall_time_ms;

  return ForecastSchema.parse({
    forecast_version: FORECAST_VERSION,
    created_at: new Date().toISOString(),
    plan_hash: sha256Text(stableJson(plan)),
    node_count: plan.nodes.length,
    max_parallel_width: Math.min(plan.limits.max_parallel, widestLayer),
    worst_case_invocations: worstCaseInvocations,
    fake_invocations: fakeInvocations,
    per_provider: perProvider,
    prompt_char_upper_bound: plan.limits.max_prompt_chars * plan.nodes.length,
    output_char_upper_bound: plan.limits.max_output_chars * plan.nodes.length,
    wall_time_upper_bound_ms: wallTimeUpperBoundMs,
    wall_time_bound_source: criticalPathWins
      ? "critical_path_estimate"
      : "limits.max_wall_time_ms",
    warnings
  });
}

/**
 * Persists a forecast as an immutable file: a second write to the same path
 * fails with EEXIST instead of silently replacing the reviewed numbers.
 */
export async function writeForecast(destination: string, forecast: Forecast): Promise<void> {
  const validated = ForecastSchema.parse(forecast);
  await writeImmutableFile(destination, `${JSON.stringify(validated, null, 2)}\n`);
}
