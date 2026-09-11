import { describe, expect, it } from "vitest";
import {
  InvocationCancelRequestedPayloadSchema,
  InvocationCancelledPayloadSchema,
  InvocationFinishedPayloadSchema,
  InvocationReplayAuthorizedPayloadSchema,
  InvocationStartedPayloadSchema,
  InvocationUnknownPayloadSchema
} from "../src/invocations.js";

const H = "a".repeat(64);
const ID = "b".repeat(32);

describe("invocation payload contracts (CR-M-069)", () => {
  it("started requires command_sha256", () => {
    expect(() =>
      InvocationStartedPayloadSchema.parse({
        invocation_id: ID,
        run_id: "r",
        node_id: "n",
        attempt: 1,
        adapter: "kimi",
        command_sha256: H
      })
    ).not.toThrow();
    expect(() =>
      InvocationStartedPayloadSchema.parse({
        invocation_id: ID,
        run_id: "r",
        node_id: "n",
        attempt: 1,
        adapter: "kimi"
      })
    ).toThrow();
  });

  it("ok requires stdout_sha256 and null failure_class", () => {
    expect(() =>
      InvocationFinishedPayloadSchema.parse({
        invocation_id: ID,
        status: "ok",
        failure_class: null,
        stdout_sha256: H,
        duration_ms: 1
      })
    ).not.toThrow();
    expect(() =>
      InvocationFinishedPayloadSchema.parse({
        invocation_id: ID,
        status: "ok",
        failure_class: "quota",
        duration_ms: 1
      })
    ).toThrow();
  });

  it("cancelled requires kill_confirmed true", () => {
    expect(() =>
      InvocationCancelledPayloadSchema.parse({
        invocation_id: ID,
        kill_confirmed: true
      })
    ).not.toThrow();
    expect(() =>
      InvocationCancelledPayloadSchema.parse({ invocation_id: ID, kill_confirmed: false })
    ).toThrow();
  });

  it("cancel_requested / unknown / replay shapes", () => {
    expect(() =>
      InvocationCancelRequestedPayloadSchema.parse({
        invocation_id: ID,
        reason: "user"
      })
    ).not.toThrow();
    expect(() =>
      InvocationUnknownPayloadSchema.parse({
        invocation_id: ID,
        marked_at_resume: true,
        prior_state: "started"
      })
    ).not.toThrow();
    expect(() =>
      InvocationReplayAuthorizedPayloadSchema.parse({
        invocation_id: ID,
        authority: "human-lead",
        target_attempt: 2
      })
    ).not.toThrow();
  });
});
