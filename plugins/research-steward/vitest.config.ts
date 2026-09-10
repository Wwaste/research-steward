import { defineConfig } from "vitest/config";

// Coverage thresholds: originally the v0.2 Task 1.1 baseline under vitest 3
// (measured 76.44/78.46/85.81/76.44, floored minus one). Re-baselined 2026-09-10
// for vitest 4's AST-aware coverage, which measures lower on the same tree
// (actuals 79.7/71.2/79.9/81.4): branches 77→70, functions 84→78 by versioned
// ruling in the execution ledger. They may only be raised from here, never lowered.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["dist/**", "scripts/**", "tests/**"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 78,
        lines: 75
      }
    }
  }
});
