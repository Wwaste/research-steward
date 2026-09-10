import { describe, expect, it } from "vitest";
import {
  EventTypeSchema,
  EventDraftSchema,
  InvocationIdSchema,
  PROTOCOL_VERSION
} from "../src/protocol.js";

describe("protocol invocation events (DESIGN-INVOCATION-LEDGER step 1)", () => {
  it("accepts the six new invocation event types", () => {
    for (const t of [
      "invocation_started",
      "invocation_finished",
      "invocation_cancel_requested",
      "invocation_cancelled",
      "invocation_unknown",
      "invocation_replay_authorized"
    ]) {
      expect(EventTypeSchema.parse(t)).toBe(t);
    }
  });

  it("still accepts pre-existing event types (append-only compatibility)", () => {
    for (const t of [
      "project_initialized",
      "packet_frozen",
      "agent_contribution",
      "acceptance",
      "blocked"
    ]) {
      expect(EventTypeSchema.parse(t)).toBe(t);
    }
    const draft = EventDraftSchema.parse({
      type: "project_initialized",
      actor: { id: "coordinator", role: "coordinator" },
      summary: "init"
    });
    expect(draft.type).toBe("project_initialized");
  });

  it("invocation ids are 32-hex", () => {
    expect(InvocationIdSchema.parse("a".repeat(32))).toHaveLength(32);
    expect(() => InvocationIdSchema.parse("not-hex")).toThrow();
    expect(PROTOCOL_VERSION).toBe("1.0");
  });
});
