import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { z } from "zod";
import { ResearchStewardError, stableJson } from "./utils.js";

/**
 * Optional Ed25519 detached signatures for events (Task 5.5). A signature
 * proves *which key* submitted bytes — not scientific correctness and not
 * acceptance authority. Private keys stay local; only public keys and
 * revocation state are shareable.
 */

export const SignatureSchema = z
  .object({
    signature_version: z.literal(1),
    algorithm: z.literal("ed25519"),
    key_id: z.string().min(1).max(100),
    project_id: z.string().min(1).max(100),
    actor_id: z.string().min(1).max(100),
    signed_at: z.string().datetime({ offset: true }),
    payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    signature_base64: z.string().min(1).max(200)
  })
  .strict();

export type EventSignature = z.infer<typeof SignatureSchema>;

export interface KeyPairLocal {
  key_id: string;
  public_key_base64: string;
  private_key_pem: string;
}

export function generateSigningKey(keyId: string): KeyPairLocal {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    key_id: keyId,
    public_key_base64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

export function eventPayloadHash(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload), "utf8").digest("hex");
}

export function signEventPayload(input: {
  payload: unknown;
  key: KeyPairLocal;
  project_id: string;
  actor_id: string;
  signed_at?: string;
}): EventSignature {
  const payload_sha256 = eventPayloadHash(input.payload);
  const message = Buffer.from(
    `${input.project_id}|${input.actor_id}|${payload_sha256}`,
    "utf8"
  );
  const signature = sign(null, message, input.key.private_key_pem);
  return SignatureSchema.parse({
    signature_version: 1,
    algorithm: "ed25519",
    key_id: input.key.key_id,
    project_id: input.project_id,
    actor_id: input.actor_id,
    signed_at: input.signed_at ?? new Date().toISOString(),
    payload_sha256,
    signature_base64: signature.toString("base64")
  });
}

export interface VerifyOptions {
  public_key_base64: string;
  revoked_key_ids?: readonly string[];
  /** Keys valid at signing time; rotation must not delete history. */
  valid_at?: string;
}

export function verifyEventSignature(
  payload: unknown,
  signature: EventSignature,
  options: VerifyOptions
): void {
  SignatureSchema.parse(signature);
  if ((options.revoked_key_ids ?? []).includes(signature.key_id)) {
    throw new ResearchStewardError(
      "SIGNATURE_KEY_REVOKED",
      `Signing key "${signature.key_id}" is revoked; the event remains historical.`,
      { key_id: signature.key_id }
    );
  }
  const expected = eventPayloadHash(payload);
  if (expected !== signature.payload_sha256) {
    throw new ResearchStewardError(
      "SIGNATURE_PAYLOAD_MISMATCH",
      "Signature payload hash does not match the provided event payload."
    );
  }
  const message = Buffer.from(
    `${signature.project_id}|${signature.actor_id}|${signature.payload_sha256}`,
    "utf8"
  );
  const publicKey = createPublicKey({
    key: Buffer.from(options.public_key_base64, "base64"),
    format: "der",
    type: "spki"
  });
  const ok = verify(
    null,
    message,
    publicKey,
    Buffer.from(signature.signature_base64, "base64")
  );
  if (!ok) {
    throw new ResearchStewardError(
      "SIGNATURE_INVALID",
      "Ed25519 detached signature did not verify for this key_id."
    );
  }
}
