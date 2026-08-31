import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function schema(name: string): Promise<Record<string, any>> {
  return JSON.parse(
    await readFile(path.join(process.cwd(), "schemas", name), "utf8")
  ) as Record<string, any>;
}

describe("published protocol schemas", () => {
  it("describes the complete hash-linked committed event", async () => {
    const event = await schema("research-event.schema.json");
    expect(event.required).toEqual(
      expect.arrayContaining([
        "previous_event_hash",
        "event_hash",
        "decisions",
        "findings",
        "metadata"
      ])
    );
    expect(event.properties.previous_event_hash.anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "null" })])
    );
    expect(event.properties.decisions.items.properties.disposition.enum).toEqual([
      "accept",
      "partial",
      "reject",
      "defer"
    ]);
  });

  it("publishes closed plan objects and the runtime limits", async () => {
    const plan = await schema("roundtable-plan.schema.json");
    expect(plan.additionalProperties).toBe(false);
    expect(plan.properties.limits.additionalProperties).toBe(false);
    expect(plan.properties.limits.properties.max_parallel.maximum).toBe(8);
    expect(plan.properties.nodes.items.additionalProperties).toBe(false);
    expect(plan.properties.nodes.items.properties.adapter.enum).toEqual([
      "kimi",
      "qoder",
      "grok",
      "fake"
    ]);
  });
});
