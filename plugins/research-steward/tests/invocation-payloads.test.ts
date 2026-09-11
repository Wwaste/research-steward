import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  InvocationCancelRequestedPayloadSchema,
  InvocationCancelledPayloadSchema,
  InvocationFinishedPayloadSchema,
  InvocationReplayAuthorizedPayloadSchema,
  InvocationStartedPayloadSchema,
  InvocationUnknownPayloadSchema
} from "../src/invocations.js";
import { freezePacket, readEvents } from "../src/store.js";
import { runRoundtable } from "../src/workflow.js";
import { initializedProject } from "./helpers.js";

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

describe("CR-M-076 production emission matches payload contracts", () => {
  it("workflow started/finished metadata parses under the strict schemas", async () => {
    process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER = "1";
    const root = await initializedProject("076-align");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-076", ["n.md"]);
    try {
      await runRoundtable(
        root,
        {
          version: 1,
          name: "align",
          packet_id: "pkt-076",
          mode: "open",
          limits: {
            max_parallel: 1,
            max_wall_time_ms: 1_800_000,
            max_prompt_chars: 20_000,
            max_output_chars: 10_000,
            retry_limit: 0,
            max_failures: 1
          },
          nodes: [
            {
              id: "n1",
              actor_id: "a1",
              role: "analyst",
              adapter: "fake",
              brief: "b",
              depends_on: [],
              visibility: "shared",
              can_adjudicate: false,
              timeout_ms: 5_000
            }
          ]
        } as never,
        "align-run"
      );
    } finally {
      delete process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER;
    }
    const events = await readEvents(root);
    const started = events.find((e) => e.type === "invocation_started");
    const finished = events.find((e) => e.type === "invocation_finished");
    expect(started).toBeDefined();
    expect(finished).toBeDefined();
    // Production metadata must satisfy the strict payload contracts.
    expect(() =>
      InvocationStartedPayloadSchema.parse(started!.metadata)
    ).not.toThrow();
    expect(() =>
      InvocationFinishedPayloadSchema.parse(finished!.metadata)
    ).not.toThrow();
    expect(started!.metadata["command_sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(started!.metadata["retry_reason"]).toBeUndefined();
    expect(finished!.metadata["status"]).toBe("ok");
  });

  it("failed started carries retry_context instead of retry_reason", async () => {
    const { appendEvent } = await import("../src/store.js");
    const root = await initializedProject("076-retry");
    // Direct contract check for the retry_context shape the emitter writes.
    const meta = {
      invocation_id: ID,
      run_id: "r",
      node_id: "n",
      attempt: 2,
      adapter: "kimi",
      command_sha256: H,
      retry_context: { reason: "retryable-transport", backoff_ms: 50 }
    };
    expect(() => InvocationStartedPayloadSchema.parse(meta)).not.toThrow();
    await appendEvent(root, {
      type: "invocation_started",
      run_id: "r",
      actor: { id: "a", role: "analyst", adapter: "kimi" },
      summary: "s",
      metadata: meta
    });
  });
});
