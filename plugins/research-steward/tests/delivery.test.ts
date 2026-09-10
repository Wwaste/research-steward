import { describe, expect, it } from "vitest";
import {
  assertIdempotentRepeat,
  declareCandidate,
  transitionDelivery
} from "../src/delivery.js";

const H = "d".repeat(64);

describe("delivery state machine (Task 5.4)", () => {
  it("walks candidate → authorized → recorded → verified with matching hash", () => {
    let record = declareCandidate({ package_id: "p1", idempotency_key: "idem", local_sha256: H });
    record = transitionDelivery(record, "delivery_authorized");
    record = transitionDelivery(record, "delivery_recorded", {
      destination: "fake://bucket/p1",
      object_id: "obj1",
      size_bytes: 10,
      sha256: H,
      recorded_at: "2026-09-10T00:00:00.000Z"
    });
    record = transitionDelivery(record, "delivery_verified");
    expect(record.state).toBe("delivery_verified");
  });

  it("fails closed on hash mismatch and illegal jumps", () => {
    const record = declareCandidate({ package_id: "p1", idempotency_key: "idem", local_sha256: H });
    expect(() => transitionDelivery(record, "delivery_verified")).toThrowError(
      expect.objectContaining({ code: "DELIVERY_INVALID_TRANSITION" })
    );
    const authorized = transitionDelivery(record, "delivery_authorized");
    expect(() =>
      transitionDelivery(authorized, "delivery_recorded", {
        destination: "x",
        object_id: "y",
        size_bytes: 1,
        sha256: "e".repeat(64),
        recorded_at: "2026-09-10T00:00:00.000Z"
      })
    ).toThrowError(expect.objectContaining({ code: "DELIVERY_HASH_MISMATCH" }));
  });

  it("rejects a different idempotency key on repeat", () => {
    const record = declareCandidate({ package_id: "p1", idempotency_key: "a", local_sha256: H });
    expect(() => assertIdempotentRepeat(record, "b")).toThrowError(
      expect.objectContaining({ code: "DELIVERY_IDEMPOTENCY_MISMATCH" })
    );
  });
});
