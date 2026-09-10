import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * RS-V1-SUP-005: coverage thresholds may only be raised, never lowered.
 * The vitest.config.ts comment is the human ruling; this file is the machine
 * lock. Update BOTH together when a versioned re-baseline is deliberately
 * accepted (as with the 2026-09-10 vitest 4 re-baseline).
 */
const FLOORS = {
  statements: 75,
  branches: 70,
  functions: 78,
  lines: 75
} as const;

describe("coverage threshold floors (RS-V1-SUP-005)", () => {
  it("keeps every coverage threshold at or above the locked floor", async () => {
    const configPath = path.join(import.meta.dirname, "..", "vitest.config.ts");
    const source = await readFile(configPath, "utf8");
    for (const [key, floor] of Object.entries(FLOORS)) {
      const match = new RegExp(`${key}:\\s*(\\d+)`).exec(source);
      expect(match, `threshold ${key} missing from vitest.config.ts`).not.toBeNull();
      const value = Number(match![1]);
      expect(
        value,
        `coverage threshold ${key}=${value} is below the locked floor ${floor}; ` +
          "thresholds may only be raised (see vitest.config.ts comment and RS-V1-SUP-005)"
      ).toBeGreaterThanOrEqual(floor);
    }
  });
});
