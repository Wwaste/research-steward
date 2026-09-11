import { describe, expect, it } from "vitest";
import {
  GateReportSchema,
  GateScenarioResultSchema,
  GateSampleSchema
} from "../src/gate-evidence.js";

describe("gate harness evidence (DESIGN-PHASE2-GATE)", () => {
  it("parses a reported_pass scenario result", () => {
    const result = GateScenarioResultSchema.parse({
      scenario_id: "G3",
      samples: [
        {
          scenario_id: "G3",
          counter_value: 1,
          ledger_head_hash: "a".repeat(64),
          event_count: 3,
          captured_at: "2026-09-11T00:00:00.000Z"
        }
      ],
      verdict: "reported_pass"
    });
    expect(result.scenario_id).toBe("G3");
  });

  it("report status is never an authoritative pass", () => {
    const report = GateReportSchema.parse({
      report_version: 1,
      generated_at: "2026-09-11T00:00:00.000Z",
      status: "reported_pass",
      scenarios: []
    });
    expect(report.status).toBe("reported_pass");
  });

  it("rejects unknown sample keys", () => {
    expect(() =>
      GateSampleSchema.parse({
        scenario_id: "G1",
        counter_value: 0,
        ledger_head_hash: null,
        event_count: 0,
        captured_at: "2026-09-11T00:00:00.000Z",
        extra: true
      })
    ).toThrow();
  });
});
