import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * RS-V1-SUP-005: coverage thresholds may only be raised, never lowered.
 * CR-M-028: values are read from the thresholds block only, not comments.
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
    const thresholdsBlock = /thresholds:\s*\{([\s\S]*?)\}/.exec(source);
    expect(thresholdsBlock, "thresholds block missing").not.toBeNull();
    const block = thresholdsBlock![1]!;
    for (const [key, floor] of Object.entries(FLOORS)) {
      const match = new RegExp(`${key}:\\s*(\\d+)`).exec(block);
      expect(match, `threshold ${key} missing from thresholds block`).not.toBeNull();
      const value = Number(match![1]);
      expect(value, `threshold ${key}=${value} below floor ${floor}`).toBeGreaterThanOrEqual(
        floor
      );
    }
  });
});
