import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoundtablePlanSchema } from "../src/protocol.js";
import { sha256Text, stableJson } from "../src/utils.js";
import {
  ForecastSchema,
  buildForecast,
  classifyRoute,
  routeWarning,
  writeForecast
} from "../src/forecast.js";

const disposableDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...disposableDirectories].map((dir) => rm(dir, { recursive: true, force: true }))
  );
  disposableDirectories.clear();
});

async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forecast-test-"));
  disposableDirectories.add(dir);
  return dir;
}

interface FixtureNode {
  id: string;
  actor_id: string;
  role: string;
  adapter: string;
  brief: string;
  depends_on: string[];
  timeout_ms?: number;
}

function node(
  id: string,
  adapter: string,
  dependsOn: string[] = [],
  timeoutMs?: number
): FixtureNode {
  return {
    id,
    actor_id: `actor-${id}`,
    role: "analyst",
    adapter,
    brief: "Bounded fixture brief for forecast tests.",
    depends_on: dependsOn,
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs })
  };
}

function plan(
  nodes: FixtureNode[],
  limitsOverride: Partial<Record<string, number>> = {}
): Record<string, unknown> {
  return {
    version: 1,
    name: "forecast fixture",
    packet_id: "packet-fixture",
    mode: "open",
    limits: {
      max_parallel: 3,
      max_wall_time_ms: 1_800_000,
      max_prompt_chars: 20_000,
      max_output_chars: 10_000,
      retry_limit: 1,
      max_failures: 3,
      ...limitsOverride
    },
    nodes
  };
}

function expectStewardCode(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected a thrown error with code ${code}`).toBeDefined();
  expect((caught as { code?: unknown }).code).toBe(code);
}

describe("classifyRoute and route warnings", () => {
  it("routes every current subscription CLI adapter to subscription_cli", () => {
    expect(classifyRoute("kimi")).toBe("subscription_cli");
    expect(classifyRoute("qoder")).toBe("subscription_cli");
    expect(classifyRoute("grok")).toBe("subscription_cli");
  });

  it("routes the fake adapter to fake", () => {
    expect(classifyRoute("fake")).toBe("fake");
  });

  it("routes any adapter it does not recognize to unknown", () => {
    expect(classifyRoute("deepseek")).toBe("unknown");
    expect(classifyRoute("")).toBe("unknown");
    expect(classifyRoute("KIMI")).toBe("unknown");
  });

  it("emits a blocking warning for an unknown route such as deepseek", () => {
    const warning = routeWarning("deepseek", classifyRoute("deepseek"));
    expect(warning).toMatchObject({
      code: "metered-or-unknown-route",
      severity: "blocking"
    });
    expect(warning?.message).toContain("deepseek");
  });

  it("emits a blocking warning for a metered_api route even though no current adapter maps to it", () => {
    const warning = routeWarning("future-metered-api", "metered_api");
    expect(warning).toMatchObject({
      code: "metered-or-unknown-route",
      severity: "blocking"
    });
    expect(warning?.message).toContain("metered_api");
  });

  it("stays silent for subscription_cli and fake routes", () => {
    expect(routeWarning("kimi", "subscription_cli")).toBeUndefined();
    expect(routeWarning("fake", "fake")).toBeUndefined();
  });
});

describe("buildForecast", () => {
  it("rejects a plan that does not satisfy RoundtablePlanSchema", () => {
    expect(() => buildForecast({})).toThrow();
    expect(() => buildForecast(plan([node("a", "deepseek")]))).toThrow();
  });

  it("computes width 1 for a linear chain even when max_parallel allows more", () => {
    const chain = plan(
      [
        node("a", "kimi"),
        node("b", "qoder", ["a"]),
        node("c", "grok", ["b"]),
        node("d", "kimi", ["c"])
      ],
      { max_parallel: 8 }
    );
    expect(buildForecast(chain).max_parallel_width).toBe(1);
  });

  it("caps wide fan-out width at max_parallel", () => {
    const fanOut = plan(
      [
        node("a", "kimi"),
        node("b", "qoder"),
        node("c", "grok"),
        node("d", "kimi"),
        node("e", "qoder")
      ],
      { max_parallel: 3 }
    );
    expect(buildForecast(fanOut).max_parallel_width).toBe(3);
  });

  it("caps width at the widest dependency layer when max_parallel is larger", () => {
    const diamond = plan(
      [
        node("a", "kimi"),
        node("b", "qoder", ["a"]),
        node("c", "grok", ["a"]),
        node("d", "kimi", ["b", "c"])
      ],
      { max_parallel: 8 }
    );
    expect(buildForecast(diamond).max_parallel_width).toBe(2);
  });

  it("counts worst_case_invocations as node_count with retry_limit 0", () => {
    const forecast = buildForecast(
      plan([node("a", "kimi"), node("b", "qoder"), node("c", "grok")], { retry_limit: 0 })
    );
    expect(forecast.worst_case_invocations).toBe(3);
    expect(forecast.fake_invocations).toBe(0);
  });

  it("counts worst_case_invocations as node_count times three with retry_limit 2", () => {
    const forecast = buildForecast(
      plan([node("a", "kimi"), node("b", "qoder"), node("c", "grok")], { retry_limit: 2 })
    );
    expect(forecast.worst_case_invocations).toBe(9);
  });

  it("keeps fake nodes out of the paid worst case and counts them separately", () => {
    const forecast = buildForecast(
      plan([node("a", "kimi"), node("b", "kimi"), node("c", "fake")], { retry_limit: 1 })
    );
    expect(forecast.worst_case_invocations).toBe(4);
    expect(forecast.fake_invocations).toBe(2);
    expect(forecast.per_provider["kimi"]).toEqual({
      nodes: 2,
      worst_case_invocations: 4,
      route: "subscription_cli"
    });
    expect(forecast.per_provider["fake"]).toEqual({
      nodes: 1,
      worst_case_invocations: 2,
      route: "fake"
    });
  });

  it("keeps the paid worst case equal to the per-provider sum", () => {
    const forecast = buildForecast(
      plan(
        [node("a", "kimi"), node("b", "qoder"), node("c", "qoder"), node("d", "fake")],
        { retry_limit: 2 }
      )
    );
    const paidSum = Object.values(forecast.per_provider)
      .filter((entry) => entry.route !== "fake")
      .reduce((sum, entry) => sum + entry.worst_case_invocations, 0);
    expect(forecast.worst_case_invocations).toBe(paidSum);
  });

  it("multiplies the character limits by node count for the char upper bounds", () => {
    const forecast = buildForecast(
      plan([node("a", "kimi"), node("b", "qoder")], {
        max_prompt_chars: 12_345,
        max_output_chars: 6_789
      })
    );
    expect(forecast.prompt_char_upper_bound).toBe(24_690);
    expect(forecast.output_char_upper_bound).toBe(13_578);
  });

  it("uses the critical-path estimate when it beats max_wall_time_ms", () => {
    const forecast = buildForecast(
      plan(
        [node("a", "kimi", [], 10_000), node("b", "qoder", ["a"], 10_000)],
        { retry_limit: 0, max_wall_time_ms: 1_800_000 }
      )
    );
    expect(forecast.wall_time_upper_bound_ms).toBe(20_000);
    expect(forecast.wall_time_bound_source).toBe("critical_path_estimate");
  });

  it("falls back to max_wall_time_ms when the critical-path estimate exceeds it", () => {
    const forecast = buildForecast(
      plan(
        [node("a", "kimi", [], 1_800_000), node("b", "qoder", ["a"], 1_800_000)],
        { retry_limit: 2, max_wall_time_ms: 600_000 }
      )
    );
    expect(forecast.wall_time_upper_bound_ms).toBe(600_000);
    expect(forecast.wall_time_bound_source).toBe("limits.max_wall_time_ms");
  });

  it("falls back to max_wall_time_ms when a layer is wider than max_parallel", () => {
    // Reviewer counterexample: five independent nodes with max_parallel 3 need
    // two scheduler batches, so one layer x 300s x 2 attempts (600s) is not an
    // upper bound -- the true worst case is two batches (1200s). The only
    // sound bound left is the workflow's hard deadline.
    const forecast = buildForecast(
      plan(
        [
          node("a", "kimi", [], 300_000),
          node("b", "qoder", [], 300_000),
          node("c", "grok", [], 300_000),
          node("d", "kimi", [], 300_000),
          node("e", "qoder", [], 300_000)
        ],
        { max_parallel: 3, retry_limit: 1, max_wall_time_ms: 1_800_000 }
      )
    );
    expect(forecast.wall_time_upper_bound_ms).toBe(1_800_000);
    expect(forecast.wall_time_bound_source).toBe("limits.max_wall_time_ms");
  });

  it("never claims to know remaining provider quota", () => {
    const serialized = JSON.stringify(
      buildForecast(plan([node("a", "kimi"), node("b", "fake")]))
    ).toLowerCase();
    expect(serialized).not.toContain("quota");
    expect(serialized).not.toContain("remaining");
  });

  it("hashes the parsed plan with sha256Text over stableJson, ignoring key order", () => {
    const fixture = plan([node("a", "kimi")]);
    const reordered = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse());
    const expected = sha256Text(stableJson(RoundtablePlanSchema.parse(fixture)));
    expect(buildForecast(fixture).plan_hash).toBe(expected);
    expect(buildForecast(shuffled).plan_hash).toBe(expected);
  });

  it("emits an info warning when the paid invocation budget exceeds 64", () => {
    const wide = plan(
      Array.from({ length: 22 }, (_, index) => node(`n${index}`, "kimi")),
      { retry_limit: 2 }
    );
    const forecast = buildForecast(wide);
    expect(forecast.worst_case_invocations).toBe(66);
    expect(forecast.warnings).toContainEqual(
      expect.objectContaining({ code: "large-invocation-budget", severity: "info" })
    );
  });

  it("does not count fake invocations toward the budget warning", () => {
    const rehearsal = plan(
      Array.from({ length: 30 }, (_, index) => node(`n${index}`, "fake")),
      { retry_limit: 2 }
    );
    const forecast = buildForecast(rehearsal);
    expect(forecast.fake_invocations).toBe(90);
    expect(forecast.worst_case_invocations).toBe(0);
    expect(forecast.warnings).toEqual([]);
  });

  it("accepts a 32-node plan and rejects a 33-node plan at the schema boundary", () => {
    const nodesOf = (count: number) =>
      Array.from({ length: count }, (_, index) => node(`n${index}`, "kimi"));
    const forecast = buildForecast(plan(nodesOf(32), { retry_limit: 0 }));
    expect(forecast.node_count).toBe(32);
    expect(() => buildForecast(plan(nodesOf(33)))).toThrow();
  });

  it("emits no warnings for a small plan on known routes", () => {
    const forecast = buildForecast(plan([node("a", "kimi"), node("b", "fake")]));
    expect(forecast.warnings).toEqual([]);
  });

  it("survives a JSON round trip through ForecastSchema.parse", () => {
    const forecast = buildForecast(
      plan([node("a", "kimi"), node("b", "fake", ["a"])], { retry_limit: 2 })
    );
    const revived = ForecastSchema.parse(JSON.parse(JSON.stringify(forecast)));
    expect(revived).toEqual(forecast);
  });

  it("rejects a plan whose dependency graph cannot be layered", () => {
    expectStewardCode(
      () => buildForecast(plan([node("a", "kimi", ["ghost"])])),
      "UNKNOWN_DEPENDENCY"
    );
    expectStewardCode(
      () => buildForecast(plan([node("a", "kimi", ["b"]), node("b", "qoder", ["a"])])),
      "CYCLIC_PLAN"
    );
    expectStewardCode(
      () => buildForecast(plan([node("a", "kimi"), node("a", "qoder")])),
      "DUPLICATE_NODE"
    );
  });

  it("stays a pure planner: the module never imports providers, store, workflow, or fs", async () => {
    const source = await readFile(
      new URL("../src/forecast.ts", import.meta.url),
      "utf8"
    );
    // Literal-substring guard, not full import analysis: it keeps the module
    // from naming these dependencies at all, which is the property we want.
    for (const banned of [
      "./providers",
      "./store",
      "./workflow",
      "node:fs",
      "node:child_process",
      ".research"
    ]) {
      expect(source, `forecast.ts must not reference ${banned}`).not.toContain(banned);
    }
  });
});

describe("writeForecast", () => {
  it("writes a schema-valid file once and refuses to overwrite it", async () => {
    const dir = await temporaryDirectory();
    const target = path.join(dir, "forecast.json");
    const first = buildForecast(plan([node("a", "kimi")]));
    await writeForecast(target, first);

    const stored = ForecastSchema.parse(JSON.parse(await readFile(target, "utf8")));
    expect(stored).toEqual(first);

    const second = buildForecast(plan([node("z", "grok")], { retry_limit: 2 }));
    const failure = await writeForecast(target, second).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure, "second write must be rejected").toBeDefined();
    expect((failure as NodeJS.ErrnoException).code).toBe("EEXIST");

    const untouched = ForecastSchema.parse(JSON.parse(await readFile(target, "utf8")));
    expect(untouched).toEqual(first);
  });
});

describe("randomized plans with a fixed-seed LCG", () => {
  function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
      return state;
    };
  }

  function randomPlan(next: () => number): Record<string, unknown> {
    const adapters = ["kimi", "qoder", "grok"] as const;
    const nodeCount = 1 + (next() % 12);
    const nodes: FixtureNode[] = [];
    for (let index = 0; index < nodeCount; index += 1) {
      const dependsOn: string[] = [];
      for (let previous = 0; previous < index && dependsOn.length < 16; previous += 1) {
        if (next() % 4 === 0) dependsOn.push(`n${previous}`);
      }
      nodes.push(
        node(
          `n${index}`,
          adapters[next() % adapters.length]!,
          dependsOn,
          1_000 + (next() % 1_000_000)
        )
      );
    }
    return plan(nodes, {
      max_parallel: 1 + (next() % 8),
      max_wall_time_ms: 60_000 + (next() % 1_000_000),
      retry_limit: next() % 3,
      max_failures: next() % 33
    });
  }

  it("keeps every invariant across 20 seeded random plans", () => {
    const next = lcg(123_456_789);
    for (let round = 0; round < 20; round += 1) {
      const fixture = randomPlan(next);
      const parsed = RoundtablePlanSchema.parse(fixture);
      const forecast = buildForecast(fixture);
      const attempts = parsed.limits.retry_limit + 1;

      expect(forecast.node_count).toBe(parsed.nodes.length);
      expect(forecast.worst_case_invocations).toBeGreaterThanOrEqual(parsed.nodes.length);
      expect(forecast.worst_case_invocations).toBeLessThanOrEqual(
        parsed.nodes.length * attempts
      );
      const paidSum = Object.values(forecast.per_provider)
        .filter((entry) => entry.route !== "fake")
        .reduce((sum, entry) => sum + entry.worst_case_invocations, 0);
      expect(forecast.worst_case_invocations).toBe(paidSum);
      expect(forecast.fake_invocations).toBe(0);

      expect(forecast.max_parallel_width).toBeGreaterThanOrEqual(1);
      expect(forecast.max_parallel_width).toBeLessThanOrEqual(
        Math.min(parsed.limits.max_parallel, parsed.nodes.length)
      );
      expect(forecast.wall_time_upper_bound_ms).toBeLessThanOrEqual(
        parsed.limits.max_wall_time_ms
      );
      expect(forecast.prompt_char_upper_bound).toBe(
        parsed.limits.max_prompt_chars * parsed.nodes.length
      );
      expect(forecast.output_char_upper_bound).toBe(
        parsed.limits.max_output_chars * parsed.nodes.length
      );
      expect(forecast.plan_hash).toBe(sha256Text(stableJson(parsed)));
      expect(ForecastSchema.parse(JSON.parse(JSON.stringify(forecast)))).toEqual(forecast);
    }
  });
});
