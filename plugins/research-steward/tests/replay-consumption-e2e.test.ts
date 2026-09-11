import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendEvent, freezePacket, readEvents } from "../src/store.js";
import { runRoundtable } from "../src/workflow.js";
import { authorizeReplay, foldInvocations, makeInvocationId } from "../src/invocations.js";
import { initializedProject } from "./helpers.js";

function plan() {
  return {
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
      max_failures: 1,
      resume_policy: "explicit" as const
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
}

describe("CR-M-071 consumption e2e", () => {
  it("authorizeReplay emits a bound authorization the fold accepts", async () => {
    const root = await initializedProject("auth-emitter");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-c", ["n.md"]);
    const id1 = makeInvocationId("a-run", "n1", 1);
    await appendEvent(root, {
      type: "invocation_started",
      run_id: "a-run",
      actor: { id: "a1", role: "analyst", adapter: "fake" },
      summary: "s",
      metadata: {
        invocation_id: id1,
        run_id: "a-run",
        node_id: "n1",
        attempt: 1,
        adapter: "fake"
      }
    });
    await appendEvent(root, {
      type: "invocation_unknown",
      run_id: "a-run",
      actor: { id: "research-steward", role: "coordinator" },
      summary: "u",
      metadata: { invocation_id: id1, marked_at_resume: true, prior_state: "started" }
    });
    await authorizeReplay(root, {
      run_id: "a-run",
      invocation_id: id1,
      authority: "human-lead",
      target_attempt: 2,
      note: "ok"
    });
    const fold = foldInvocations((await readEvents(root)).filter((e) => e.run_id === "a-run"));
    expect(fold.get(id1)!.replay_authorized).toBe(true);
    expect(fold.get(id1)!.replay_authorized_attempt).toBe(2);
  });

  it("after attempt-2 also crashes, a second resume refuses replay without new auth", async () => {
    process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER = "1";
    const root = await initializedProject("consume");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-c", ["n.md"]);
    const id1 = makeInvocationId("c-run", "n1", 1);
    const id2 = makeInvocationId("c-run", "n1", 2);
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
        adapter: "fake"
      }
    });
    await appendEvent(root, {
      type: "invocation_unknown",
      run_id: "c-run",
      actor: { id: "research-steward", role: "coordinator" },
      summary: "u",
      metadata: { invocation_id: id1, marked_at_resume: true, prior_state: "started" }
    });
    await authorizeReplay(root, {
      run_id: "c-run",
      invocation_id: id1,
      authority: "human-lead",
      target_attempt: 2
    });
    // Authorized replay starts attempt 2, then the process dies: only started
    // is durable. This is the crash that must consume the authorization.
    await appendEvent(root, {
      type: "invocation_started",
      run_id: "c-run",
      actor: { id: "a1", role: "analyst", adapter: "fake" },
      summary: "replay started then crashed",
      metadata: {
        invocation_id: id2,
        run_id: "c-run",
        node_id: "n1",
        attempt: 2,
        adapter: "fake"
      }
    });
    let fold = foldInvocations((await readEvents(root)).filter((e) => e.run_id === "c-run"));
    expect(fold.get(id1)!.replay_consumed).toBe(true);
    expect(fold.get(id1)!.replay_authorized).toBe(false);

    const providers = await import("../src/providers.js");
    const spy = vi.spyOn(providers, "runProvider");
    try {
      // Resume: marks id2 unknown, then must refuse replay (no auth for attempt 3).
      const result = await runRoundtable(root, plan(), "c-run");
      expect(result.outcome).toBe("failed");
      expect(spy).not.toHaveBeenCalled();
      const events = await readEvents(root);
      const id3 = makeInvocationId("c-run", "n1", 3);
      expect(
        events.some((e) => e.type === "invocation_started" && e.metadata["invocation_id"] === id3)
      ).toBe(false);
      const blocked = events.find(
        (e) =>
          e.type === "agent_contribution" &&
          e.metadata["node_id"] === "n1" &&
          e.metadata["blocked_by"] === "unknown_outcome"
      );
      expect(blocked).toBeDefined();
      fold = foldInvocations(events.filter((e) => e.run_id === "c-run"));
      expect(fold.get(id2)!.state).toBe("unknown");
      expect(fold.get(id2)!.replay_authorized).toBe(false);
    } finally {
      spy.mockRestore();
      delete process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER;
    }
  });
});
