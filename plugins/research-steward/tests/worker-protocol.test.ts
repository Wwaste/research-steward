import { describe, expect, it } from "vitest";
import {
  assertAssignable,
  contentAddressedInput,
  idempotencyKey,
  isLeaseExpired,
  selectDownstreamResult,
  type JobResult,
  type WorkerCapability
} from "../src/worker-protocol.js";

const cap: WorkerCapability = {
  worker_id: "w1",
  adapters: ["fake"],
  skills: ["artifact-verification"],
  max_concurrency: 2,
  confidentiality: "internal"
};

function result(attempt: number, status: JobResult["status"]): JobResult {
  return {
    result_version: 1,
    job_id: "j1",
    attempt,
    worker_id: "w1",
    status,
    output_sha256: "c".repeat(64),
    finished_at: "2026-09-10T00:00:00.000Z",
    accepted_for_downstream: false
  };
}

describe("worker protocol (Task 4.1)", () => {
  it("refuses capability and confidentiality mismatch without downgrade", () => {
    expect(() => assertAssignable(cap, { adapter: "qoder", confidentiality: "public" })).toThrowError(
      expect.objectContaining({ code: "WORKER_CAPABILITY_MISMATCH" })
    );
    expect(() =>
      assertAssignable(cap, { confidentiality: "restricted" })
    ).toThrowError(expect.objectContaining({ code: "WORKER_CONFIDENTIALITY_MISMATCH" }));
    expect(() => assertAssignable(cap, { adapter: "fake", confidentiality: "internal" })).not.toThrow();
  });

  it("selects only the earliest succeeded attempt for downstream", () => {
    const chosen = selectDownstreamResult([
      result(1, "failed"),
      result(2, "succeeded"),
      result(3, "succeeded")
    ]);
    expect(chosen?.attempt).toBe(2);
    expect(chosen?.accepted_for_downstream).toBe(true);
  });

  it("content-addresses input and derives idempotency keys", () => {
    const h = contentAddressedInput({ a: 1 });
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(idempotencyKey("j", h, 1)).toHaveLength(32);
    expect(idempotencyKey("j", h, 1)).toBe(idempotencyKey("j", h, 1));
    expect(idempotencyKey("j", h, 1)).not.toBe(idempotencyKey("j", h, 2));
  });

  it("detects expired leases", () => {
    expect(
      isLeaseExpired({
        lease_version: 1,
        job_id: "j",
        worker_id: "w",
        attempt: 1,
        acquired_at: "2026-09-10T00:00:00.000Z",
        expires_at: "2026-09-10T00:01:00.000Z",
        idempotency_key: "k",
        input_sha256: "a".repeat(64),
        confidentiality: "public"
      }, new Date("2026-09-10T00:02:00.000Z"))
    ).toBe(true);
  });
});
