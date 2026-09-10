import { describe, expect, it } from "vitest";
import {
  eventPayloadHash,
  generateSigningKey,
  signEventPayload,
  verifyEventSignature
} from "../src/signatures.js";

describe("event signatures (Task 5.5)", () => {
  it("signs and verifies a payload", () => {
    const key = generateSigningKey("k1");
    const payload = { type: "candidate_declared", summary: "hello" };
    const sig = signEventPayload({
      payload,
      key,
      project_id: "proj",
      actor_id: "actor-1"
    });
    expect(() =>
      verifyEventSignature(payload, sig, { public_key_base64: key.public_key_base64 })
    ).not.toThrow();
    expect(sig.payload_sha256).toBe(eventPayloadHash(payload));
  });

  it("rejects payload tampering and revoked keys", () => {
    const key = generateSigningKey("k1");
    const payload = { a: 1 };
    const sig = signEventPayload({
      payload,
      key,
      project_id: "p",
      actor_id: "a"
    });
    expect(() =>
      verifyEventSignature({ a: 2 }, sig, { public_key_base64: key.public_key_base64 })
    ).toThrowError(expect.objectContaining({ code: "SIGNATURE_PAYLOAD_MISMATCH" }));
    expect(() =>
      verifyEventSignature(payload, sig, {
        public_key_base64: key.public_key_base64,
        revoked_key_ids: ["k1"]
      })
    ).toThrowError(expect.objectContaining({ code: "SIGNATURE_KEY_REVOKED" }));
  });

  it("rejects a signature from a different key", () => {
    const k1 = generateSigningKey("k1");
    const k2 = generateSigningKey("k2");
    const payload = { x: true };
    const sig = signEventPayload({ payload, key: k1, project_id: "p", actor_id: "a" });
    expect(() =>
      verifyEventSignature(payload, sig, { public_key_base64: k2.public_key_base64 })
    ).toThrowError(expect.objectContaining({ code: "SIGNATURE_INVALID" }));
  });
});
