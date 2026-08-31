import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RoundtablePlanSchema, type RoundtablePlan } from "../src/protocol.js";
import { sha256Text, stableJson } from "../src/utils.js";
import {
  BUILT_IN_SKILL_IDS,
  PRESETS,
  PRESET_IDS,
  type RoundtablePreset
} from "../src/presets.js";
import {
  WorkflowLockSchema,
  buildPlan,
  validatePlanStructure,
  writeLock,
  type BuildPlanInput,
  type WorkflowLock
} from "../src/planner.js";
import { temporaryDirectory } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKET_ID = "packet-tdd-001";

function preset(id: string): RoundtablePreset {
  const found = PRESETS[id];
  if (!found) throw new Error(`Preset ${id} is missing from PRESETS.`);
  return found;
}

function planNode(plan: RoundtablePlan, id: string) {
  const found = plan.nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Plan is missing node ${id}.`);
  return found;
}

function build(
  presetId: string,
  overrides?: NonNullable<BuildPlanInput["overrides"]>
): { plan: RoundtablePlan; lock: WorkflowLock } {
  return buildPlan({
    preset_id: presetId,
    packet_id: PACKET_ID,
    ...(overrides ? { overrides } : {})
  });
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? "";
  }
  throw new Error("Expected the function to throw, but it returned normally.");
}

function assertAcyclic(plan: RoundtablePlan): void {
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const states = new Map<string, "visiting" | "done">();
  const visit = (id: string): void => {
    const state = states.get(id);
    if (state === "done") return;
    expect(state, `cycle through node ${id}`).not.toBe("visiting");
    states.set(id, "visiting");
    for (const dependency of nodes.get(id)?.depends_on ?? []) visit(dependency);
    states.set(id, "done");
  };
  for (const node of plan.nodes) visit(node.id);
}

function assertStructuralInvariants(plan: RoundtablePlan): void {
  expect(() => validatePlanStructure(plan)).not.toThrow();
  assertAcyclic(plan);

  const groupSizes = new Map<string, number>();
  for (const node of plan.nodes) {
    if (node.blind_group !== undefined) {
      groupSizes.set(node.blind_group, (groupSizes.get(node.blind_group) ?? 0) + 1);
    }
  }
  for (const [group, size] of groupSizes) {
    expect(size, `blind group ${group}`).toBeGreaterThanOrEqual(2);
  }

  for (const node of plan.nodes) {
    if (!node.can_adjudicate) continue;
    expect(node.depends_on.length, `adjudicator ${node.id}`).toBeGreaterThan(0);
    // Structurally, the same actor must never author a finding and adjudicate
    // it: the adjudicating node cannot appear in its own dependency list, and
    // none of its upstream contributions may come from its own actor.
    expect(node.depends_on).not.toContain(node.id);
    for (const dependency of node.depends_on) {
      expect(planNode(plan, dependency).actor_id).not.toBe(node.actor_id);
    }
  }
}

function legalModes(definition: RoundtablePreset): Array<"open" | "blind" | "mixed"> {
  const blindCount = definition.nodes.filter((node) => node.visibility === "blind").length;
  if (blindCount === 0) return ["open"];
  if (blindCount === definition.nodes.length) return ["blind"];
  return ["blind", "mixed"];
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("pick() from an empty list");
  return item;
}

describe("presets", () => {
  it("exposes exactly the seven fixed preset ids", () => {
    expect([...PRESET_IDS].sort()).toEqual(
      [
        "quick-review",
        "blind-triad",
        "full-panel",
        "producer-reviewer-revision",
        "manuscript-strict",
        "figure-audit",
        "code-science-audit"
      ].sort()
    );
    for (const id of PRESET_IDS) {
      expect(preset(id).preset_id).toBe(id);
      expect(preset(id).preset_version).toBe("1.0.0");
    }
  });

  it("keeps the presets/ JSON files identical to the TypeScript constants", async () => {
    const dir = path.join(repoRoot, "presets");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    expect(files).toEqual([...PRESET_IDS].map((id) => `${id}.json`).sort());
    for (const id of PRESET_IDS) {
      const onDisk = JSON.parse(await readFile(path.join(dir, `${id}.json`), "utf8"));
      expect(onDisk, `presets/${id}.json drifted from src/presets.ts`).toEqual(preset(id));
    }
  });

  it("lists the eight v0.1 built-in skills, matching the skills/ directory", async () => {
    const entries = await readdir(path.join(repoRoot, "skills"), { withFileTypes: true });
    const onDisk = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(BUILT_IN_SKILL_IDS).toHaveLength(8);
    expect([...BUILT_IN_SKILL_IDS].sort()).toEqual(onDisk);
  });
});

describe("buildPlan", () => {
  it("builds a schema-valid, structurally valid plan and lock for every preset", () => {
    for (const id of PRESET_IDS) {
      const { plan, lock } = build(id);

      const reparsed = RoundtablePlanSchema.parse(plan);
      expect(reparsed).toEqual(plan);
      assertStructuralInvariants(plan);

      expect(WorkflowLockSchema.parse(lock)).toEqual(lock);
      expect(lock.lock_version).toBe(1);
      expect(lock.preset_id).toBe(id);
      expect(lock.preset_version).toBe("1.0.0");
      expect(lock.generator_version).toBe("planner/0.2.0");
      expect(lock.packet_id).toBe(PACKET_ID);
      expect(lock.skill_ids).toEqual(BUILT_IN_SKILL_IDS);

      expect(Object.keys(lock.provider_routes)).toEqual(plan.nodes.map((node) => node.id));
      for (const node of plan.nodes) {
        const route = lock.provider_routes[node.id];
        expect(route?.adapter).toBe(node.adapter);
        expect(route?.route).toBe(node.adapter === "fake" ? "fake" : "subscription_cli");
      }

      for (const node of plan.nodes) {
        expect(node.brief).not.toContain("{{packet_id}}");
        expect(node.brief).toContain(PACKET_ID);
      }
    }
  });

  it("keeps the blind triad intact: three peers in one group, adjudicator depends on all", () => {
    const { plan } = build("blind-triad");
    const members = plan.nodes.filter((node) => node.blind_group !== undefined);
    expect(members).toHaveLength(3);
    expect(new Set(members.map((node) => node.blind_group)).size).toBe(1);
    for (const member of members) {
      expect(member.visibility).toBe("blind");
      expect(member.depends_on).toEqual([]);
    }
    const adjudicator = plan.nodes.find((node) => node.can_adjudicate);
    expect(adjudicator).toBeDefined();
    expect([...(adjudicator?.depends_on ?? [])].sort()).toEqual(
      members.map((node) => node.id).sort()
    );
  });

  it("routes adapter and model overrides into the lock", () => {
    const { plan, lock } = build("quick-review", {
      adapters: { reviewer: "qoder" },
      models: { reviewer: "qoder-large" }
    });
    expect(planNode(plan, "reviewer").adapter).toBe("qoder");
    expect(planNode(plan, "reviewer").model).toBe("qoder-large");
    expect(lock.provider_routes["reviewer"]).toEqual({
      adapter: "qoder",
      model: "qoder-large",
      route: "subscription_cli"
    });
    expect(lock.provider_routes["adjudicator"]).toEqual({ adapter: "fake", route: "fake" });
    expect(lock.capability_gaps.join("\n")).toContain("adjudicator");
    expect(lock.capability_gaps.join("\n")).not.toContain('"reviewer"');
  });

  it("applies brief and limit overrides, substituting the packet id", () => {
    const { plan } = build("quick-review", {
      briefs: { reviewer: "Focus only on section 2 of {{packet_id}}." },
      limits: { max_parallel: 1, retry_limit: 0 }
    });
    expect(planNode(plan, "reviewer").brief).toBe(`Focus only on section 2 of ${PACKET_ID}.`);
    expect(plan.limits.max_parallel).toBe(1);
    expect(plan.limits.retry_limit).toBe(0);
  });

  it("rejects overriding a blind node's adapter to kimi", () => {
    expect(
      errorCode(() => build("blind-triad", { adapters: { "blind-reviewer-1": "kimi" } }))
    ).toBe("BLIND_ADAPTER_UNSAFE");
  });

  it("accepts kimi on an open, shared node", () => {
    const { lock } = build("quick-review", { adapters: { reviewer: "kimi" } });
    expect(lock.provider_routes["reviewer"]).toEqual({ adapter: "kimi", route: "subscription_cli" });
  });

  it("rejects unknown node ids in adapters, models, and briefs overrides", () => {
    expect(errorCode(() => build("quick-review", { adapters: { ghost: "qoder" } }))).toBe(
      "UNKNOWN_PLAN_NODE"
    );
    expect(errorCode(() => build("quick-review", { models: { ghost: "m" } }))).toBe(
      "UNKNOWN_PLAN_NODE"
    );
    expect(errorCode(() => build("quick-review", { briefs: { ghost: "b" } }))).toBe(
      "UNKNOWN_PLAN_NODE"
    );
  });

  it("rejects unknown override fields and unknown presets", () => {
    expect(
      errorCode(() =>
        buildPlan({
          preset_id: "quick-review",
          packet_id: PACKET_ID,
          overrides: { skills: ["x"] }
        } as unknown as BuildPlanInput)
      )
    ).toBe("INVALID_PLANNER_INPUT");
    expect(errorCode(() => build("no-such-preset"))).toBe("UNKNOWN_PRESET");
  });

  it("rejects a mode override that breaks blindness, accepts one that keeps it", () => {
    expect(errorCode(() => build("blind-triad", { mode: "open" }))).toBe(
      "OPEN_MODE_HAS_BLIND_NODE"
    );
    expect(errorCode(() => build("quick-review", { mode: "blind" }))).toBe(
      "BLIND_MODE_WITHOUT_BLIND_REVIEW"
    );
    const { plan } = build("blind-triad", { mode: "mixed" });
    expect(plan.mode).toBe("mixed");
    assertStructuralInvariants(plan);
  });

  it("locks a plan_hash that matches an independent recomputation", () => {
    const { plan, lock } = build("manuscript-strict");
    expect(lock.plan_hash).toBe(sha256Text(stableJson(plan)));
    expect(lock.plan_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("validatePlanStructure (local mirror of workflow.ts validateGraph)", () => {
  const clonePlan = (id: string): RoundtablePlan => structuredClone(build(id).plan);

  it("rejects a blind group with fewer than two members", () => {
    const plan = clonePlan("blind-triad");
    plan.nodes = plan.nodes.filter(
      (node) => node.id !== "blind-reviewer-2" && node.id !== "blind-reviewer-3"
    );
    const adjudicator = planNode(plan, "adjudicator");
    adjudicator.depends_on = ["blind-reviewer-1"];
    expect(errorCode(() => validatePlanStructure(plan))).toBe("BLIND_GROUP_TOO_SMALL");
  });

  it("rejects a downstream node that depends on part of a blind group", () => {
    const plan = clonePlan("blind-triad");
    planNode(plan, "adjudicator").depends_on = ["blind-reviewer-1", "blind-reviewer-2"];
    expect(errorCode(() => validatePlanStructure(plan))).toBe("PARTIAL_BLIND_GROUP_DEPENDENCY");
  });

  it("rejects dependencies between members of the same blind group", () => {
    const plan = clonePlan("blind-triad");
    planNode(plan, "blind-reviewer-2").depends_on = ["blind-reviewer-1"];
    expect(errorCode(() => validatePlanStructure(plan))).toBe("BLINDNESS_VIOLATION");
  });

  it("rejects an adjudicator with no dependencies", () => {
    const plan = clonePlan("quick-review");
    planNode(plan, "adjudicator").depends_on = [];
    expect(errorCode(() => validatePlanStructure(plan))).toBe("ADJUDICATOR_WITHOUT_INPUT");
  });

  it("rejects cycles", () => {
    const plan = clonePlan("producer-reviewer-revision");
    planNode(plan, "producer").depends_on = ["reviser"];
    expect(errorCode(() => validatePlanStructure(plan))).toBe("CYCLIC_PLAN");
  });

  it("rejects kimi on a blind node", () => {
    const plan = clonePlan("blind-triad");
    planNode(plan, "blind-reviewer-1").adapter = "kimi";
    expect(errorCode(() => validatePlanStructure(plan))).toBe("BLIND_ADAPTER_UNSAFE");
  });

  it("rejects unknown dependencies and duplicate node ids", () => {
    const unknownDep = clonePlan("quick-review");
    planNode(unknownDep, "adjudicator").depends_on = ["ghost"];
    expect(errorCode(() => validatePlanStructure(unknownDep))).toBe("UNKNOWN_DEPENDENCY");

    const duplicated = clonePlan("quick-review");
    duplicated.nodes = [...duplicated.nodes, structuredClone(planNode(duplicated, "reviewer"))];
    expect(errorCode(() => validatePlanStructure(duplicated))).toBe("DUPLICATE_NODE");
  });
});

describe("workflow lock", () => {
  it("writeLock writes once and refuses to overwrite", async () => {
    const dir = await temporaryDirectory();
    const target = path.join(dir, "workflow.lock.json");
    const { lock } = build("figure-audit");
    await writeLock(target, lock);

    const onDisk = JSON.parse(await readFile(target, "utf8"));
    expect(WorkflowLockSchema.parse(onDisk)).toEqual(lock);

    const { lock: second } = build("code-science-audit");
    await expect(writeLock(target, second)).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(onDisk);
  });

  it("keeps schemas/workflow-lock.schema.json consistent with the Zod schema", async () => {
    const raw = JSON.parse(
      await readFile(path.join(repoRoot, "schemas", "workflow-lock.schema.json"), "utf8")
    );
    expect(raw.type).toBe("object");
    expect(raw.additionalProperties).toBe(false);
    expect([...raw.required].sort()).toEqual(Object.keys(WorkflowLockSchema.shape).sort());
    expect(raw.properties.lock_version.const).toBe(1);
    expect(raw.properties.generator_version.const).toBe("planner/0.2.0");
    const routeSchema = raw.properties.provider_routes.additionalProperties;
    expect([...routeSchema.properties.adapter.enum].sort()).toEqual([
      "fake",
      "grok",
      "kimi",
      "qoder"
    ]);
    expect([...routeSchema.properties.route.enum].sort()).toEqual(["fake", "subscription_cli"]);
    expect([...routeSchema.required].sort()).toEqual(["adapter", "route"]);
  });
});

describe("property: seeded random legal overrides preserve structural invariants", () => {
  it("holds across 200 generated override combinations", () => {
    const random = makeRandom(0x5eed_2026);
    const adapterChoicesOpen = ["kimi", "qoder", "grok", "fake"] as const;
    const adapterChoicesBlind = ["qoder", "grok", "fake"] as const;

    for (let iteration = 0; iteration < 200; iteration += 1) {
      const definition = preset(pick(random, PRESET_IDS));
      const overrides: NonNullable<BuildPlanInput["overrides"]> = {};

      if (random() < 0.35) overrides.mode = pick(random, legalModes(definition));

      const adapters: Record<string, "kimi" | "qoder" | "grok" | "fake"> = {};
      const models: Record<string, string> = {};
      const briefs: Record<string, string> = {};
      for (const node of definition.nodes) {
        if (random() < 0.3) {
          adapters[node.id] = pick(
            random,
            node.visibility === "blind" ? adapterChoicesBlind : adapterChoicesOpen
          );
        }
        if (random() < 0.2) models[node.id] = `model-${Math.floor(random() * 1000)}`;
        if (random() < 0.2) {
          briefs[node.id] = `Override brief ${iteration} for {{packet_id}}, node ${node.id}.`;
        }
      }
      if (Object.keys(adapters).length > 0) overrides.adapters = adapters;
      if (Object.keys(models).length > 0) overrides.models = models;
      if (Object.keys(briefs).length > 0) overrides.briefs = briefs;

      if (random() < 0.3) {
        overrides.limits = {
          max_parallel: 1 + Math.floor(random() * 8),
          retry_limit: Math.floor(random() * 3),
          max_wall_time_ms: pick(random, [1_000, 60_000, 1_800_000, 7_200_000]),
          max_failures: Math.floor(random() * 33)
        };
      }

      const { plan, lock } = build(definition.preset_id, overrides);
      assertStructuralInvariants(plan);
      expect(lock.plan_hash).toBe(sha256Text(stableJson(plan)));
      for (const node of plan.nodes) {
        expect(lock.provider_routes[node.id]?.route).toBe(
          node.adapter === "fake" ? "fake" : "subscription_cli"
        );
      }
    }
  });
});
