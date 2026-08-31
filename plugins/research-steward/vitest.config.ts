import { defineConfig } from "vitest/config";

// Coverage thresholds are the v0.2 Task 1.1 baseline: the measured totals
// (statements 76.44, branches 78.46, functions 85.81, lines 76.44) floored to
// integers minus one. They may only be raised in later tasks, never lowered.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["dist/**", "scripts/**", "tests/**"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 75,
        branches: 77,
        functions: 84,
        lines: 75
      }
    }
  }
});
