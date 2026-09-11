import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendEvent, freezePacket, readEvents } from "../src/store.js";
import { runRoundtable } from "../src/workflow.js";
import { foldInvocations, makeInvocationId } from "../src/invocations.js";
import { initializedProject } from "./helpers.js";

/**
 * CR-M-071 second half: authorization is consumed after replay; a second
 * crash requires a new authorization (production events only).
 */
describe("CR-M-071 consumption e2e", () => {
  it("after authorized replay crash, a new auth is required", async () => {
    process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER = "1";
    const root = await initializedProject("consume");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-c", ["n.md"]);
    const id1 = makeInvocationId("c-run", "n1", 1);
    await appendEvent(root, {
      type: "invocation_started",
      run_id: "c-run",
      actor: { id: "a1", role: "analyst", adapter: "fake" },
      summary: "s",
      metadata: {
        invocation_id: id1,
        run_id: "c-run",
        node_id: "n1",
        attempt: 1,
        adapter: "fake",
        command_sha256: "a".repeat(64)
      }
    });
    await appendEvent(root, {
      type: "invocation_unknown",
      run_id: "c-run",
      actor: { id: "research-steward", role: "coordinator" },
      summary: "u",
      metadata: { invocation_id: id1, marked_at_resume: true, prior_state: "started" }
    });
    await appendEvent(root, {
      type: "invocation_replay_authorized",
      run_id: "c-run",
      actor: { id: "human-lead", role: "authority" },
      summary: "auth1",
      metadata: {
        invocation_id: id1,
        authority: "human-lead",
        target_attempt: 2
      }
    });
    const plan = {
      version: 1,
      name: "c",
      packet_id: "pkt-c",
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
    } as never;
    try {
      await runRoundtable(root, plan, "c-run");
    } catch {
      // replay attempt may fail; we assert consumption below
    }
    let events = await readEvents(root);
    const id2 = makeInvocationId("c-run", "n1", 2);
    expect(
      events.some((e) => e.type === "invocation_started" && e.metadata["invocation_id"] === id2)
    ).toBe(true);
    // Crash the replayed attempt
    await appendEvent(root, {
      type: "invocation_unknown",
      run_id: "c-run",
      actor: { id: "research-steward", role: "coordinator" },
      summary: "u2",
      metadata: { invocation_id: id2, marked_at_resume: true, prior_state: "started" }
    });
    events = await readEvents(root);
    const fold = foldInvocations(events.filter((e) => e.run_id === "c-run"));
    // id1 auth must be consumed; id2 has no auth
    expect(fold.get(id1)!.replay_consumed || fold.get(id1)!.replay_authorized === false).toBe(true);
    expect(fold.get(id2)!.replay_authorized).toBe(false);
    // Second resume must not auto-replay id2
    const { runProvider } = await import("../src/providers.js");
    const spy = vi.spyOn(await import("../src/providers.js"), "runProvider");
    try {
      await runRoundtable(root, plan, "c-run");
    } catch {
      // expected fail
    }
    // No new started for attempt 3 without new auth
    const after = await readEvents(root);
    const id3 = makeInvocationId("c-run", "n1", 3);
    expect(
      after.some((e) => e.type === "invocation_started" && e.metadata["invocation_id"] === id3)
    ).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    delete process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER;
  });
});
