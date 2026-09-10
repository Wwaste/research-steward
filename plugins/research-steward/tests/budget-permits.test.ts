import { describe, expect, it } from "vitest";
import {
  acquirePermit,
  assertBudgetAllows,
  remainingBudget
} from "../src/budget-permits.js";
import { temporaryDirectory } from "./helpers.js";

describe("budget permits (Task 2.3 module)", () => {
  it("grants and releases permits under the concurrency cap", async () => {
    const runtimeDir = await temporaryDirectory();
    const a = await acquirePermit({ runtimeDir, provider: "fake", maxConcurrent: 1 });
    await expect(
      acquirePermit({ runtimeDir, provider: "fake", maxConcurrent: 1 })
    ).rejects.toMatchObject({ code: "PERMIT_EXHAUSTED" });
    await a.release();
    const b = await acquirePermit({ runtimeDir, provider: "fake", maxConcurrent: 1 });
    await b.release();
  });

  it("enforces window budget without guessing real quota", () => {
    const window = {
      provider: "kimi",
      window_start: "2026-09-10T00:00:00.000Z",
      max_invocations: 2,
      used: 2
    };
    expect(remainingBudget(window)).toBe(0);
    expect(() => assertBudgetAllows(window)).toThrowError(
      expect.objectContaining({ code: "BUDGET_EXCEEDED" })
    );
  });
});
