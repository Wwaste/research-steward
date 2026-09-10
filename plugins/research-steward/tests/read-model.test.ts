import { describe, expect, it } from "vitest";
import {
  emptyReadModel,
  filterAttention,
  summarizeForFirstScreen
} from "../src/read-model.js";

describe("control-plane read model (Task 5.1)", () => {
  it("summarizes first-screen fields", () => {
    const model = emptyReadModel("2026-09-10T00:00:00.000Z");
    const summary = summarizeForFirstScreen(model);
    expect(summary.status).toContain("No projects");
    expect(summary.blocked_count).toBe(0);
    expect(summary.next_decision).toBeNull();
  });

  it("filters attention by kind", () => {
    const model = emptyReadModel("2026-09-10T00:00:00.000Z");
    const withItems = {
      ...model,
      attention: [
        {
          id: "a1",
          kind: "decision" as const,
          summary: "approve?",
          digest_hash: "a".repeat(64)
        },
        {
          id: "a2",
          kind: "blocker" as const,
          summary: "missing sample",
          digest_hash: "b".repeat(64)
        }
      ]
    };
    expect(filterAttention(withItems, ["decision"])).toHaveLength(1);
  });
});
