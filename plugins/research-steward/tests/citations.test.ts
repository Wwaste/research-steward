import { describe, expect, it } from "vitest";
import {
  assertNotClaimingCleanRetraction,
  doiCandidate,
  offlineCitationCheck
} from "../src/citations.js";

describe("citations (Task 3.6 module)", () => {
  it("marks all network gates not_checked when offline", () => {
    const check = offlineCitationCheck("ref-1");
    expect(check.gates.retraction).toBe("not_checked");
    expect(check.checked_at).toBeNull();
    expect(() => assertNotClaimingCleanRetraction(check)).not.toThrow();
  });

  it("normalizes DOI candidates without rewriting bibliographies", () => {
    expect(doiCandidate("https://doi.org/10.1000/xyz123")).toEqual({
      ok: true,
      normalized: "10.1000/xyz123"
    });
    expect(doiCandidate("not-a-doi").ok).toBe(false);
  });
});
