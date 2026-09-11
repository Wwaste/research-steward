import { describe, expect, it } from "vitest";
import {
  acquirePermitSlot,
  assertBudgetAllowsFromLedger,
  countPaidInvocationsInWindow
} from "../src/budget-permits.js";
import type { CommittedEvent } from "../src/protocol.js";
import { temporaryDirectory } from "./helpers.js";

function startedEvent(adapter: string, created_at: string): CommittedEvent {
  return {
    type: "invocation_started",
    timestamp: created_at,
    metadata: { adapter, invocation_id: "a".repeat(32) }
  } as unknown as CommittedEvent;
}

describe("permit slots (DESIGN-BUDGET-PERMITS)", () => {
  it("maxConcurrent=1: exactly one of two concurrent acquires wins", async () => {
    const runtimeRoot = await temporaryDirectory();
    const results = await Promise.allSettled([
      acquirePermitSlot({ runtimeRoot, provider: "fake", maxConcurrent: 1, waitMs: 5 }),
      acquirePermitSlot({ runtimeRoot, provider: "fake", maxConcurrent: 1, waitMs: 5, attempts: 3 })
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(1);
    const handle = (fulfilled[0] as { value: { release: () => Promise<void> } }).value;
    await handle.release();
  });

  it("rejects path-escaping provider names", async () => {
    const runtimeRoot = await temporaryDirectory();
    await expect(
      acquirePermitSlot({ runtimeRoot, provider: "../evil", maxConcurrent: 1 })
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_NAME" });
  });
});

describe("budget fold from ledger (DESIGN-BUDGET-PERMITS)", () => {
  it("counts paid invocation_started events after window_start", () => {
    const events = [
      startedEvent("kimi", "2026-09-11T00:00:00.000Z"),
      startedEvent("kimi", "2026-09-11T01:00:00.000Z"),
      startedEvent("fake", "2026-09-11T01:00:00.000Z")
    ];
    expect(
      countPaidInvocationsInWindow(events, "2026-09-11T00:30:00.000Z", ["kimi"])
    ).toBe(1);
  });

  it("assertBudgetAllowsFromLedger fails closed at the cap", () => {
    const events = [startedEvent("kimi", "2026-09-11T01:00:00.000Z")];
    expect(() =>
      assertBudgetAllowsFromLedger({
        events,
        window_start: "2026-09-11T00:00:00.000Z",
        max_invocations: 1,
        provider: "kimi"
      })
    ).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
    expect(() =>
      assertBudgetAllowsFromLedger({
        events,
        window_start: "2026-09-11T00:00:00.000Z",
        max_invocations: 2,
        provider: "kimi"
      })
    ).not.toThrow();
  });
});
