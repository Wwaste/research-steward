import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvent, freezePacket, readEvents } from "../src/store.js";
import { runRoundtable } from "../src/workflow.js";
import { allowsAutoReplay, foldInvocations, makeInvocationId, nextAttempt } from "../src/invocations.js";
import { initializedProject } from "./helpers.js";

function plan(adapter: "fake" | "kimi" = "fake") {
  return {
    version: 1,
    name: "rb",
    packet_id: "pkt-rb",
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
        adapter,
        brief: "b",
        depends_on: [],
        visibility: "shared",
        can_adjudicate: false,
        timeout_ms: 5_000
      }
    ]
  } as never;
}

describe("CR-M-071 authorized replay binds next attempt", () => {
  it("auth→replay consumes; second crash needs new auth", () => {
    const id1 = makeInvocationId("r", "n1", 1);
    const id2 = makeInvocationId("r", "n1", 2);
    const events = [
      {
        type: "invocation_started",
        metadata: { invocation_id: id1, run_id: "r", node_id: "n1", attempt: 1, adapter: "kimi" }
      },
      {
        type: "invocation_unknown",
        metadata: { invocation_id: id1, marked_at_resume: true, prior_state: "started" }
      },
      {
        type: "invocation_replay_authorized",
        metadata: {
          invocation_id: id1,
          authority: "human-lead",
          note: "ok",
          target_attempt: 2
        }
      }
    ] as never;
    let map = foldInvocations(events as never);
    const unknown = map.get(id1)!;
    expect(allowsAutoReplay(unknown, { resume_policy: "explicit" })).toBe(true);
    expect(nextAttempt(unknown)).toBe(2);
    // Replay spawn → new started at attempt 2 consumes the auth.
    map = foldInvocations([
      ...((events as never[]) as never[]),
      {
        type: "invocation_started",
        metadata: { invocation_id: id2, run_id: "r", node_id: "n1", attempt: 2, adapter: "kimi" }
      },
      {
        type: "invocation_unknown",
        metadata: { invocation_id: id2, marked_at_resume: true, prior_state: "started" }
      }
    ] as never);
    expect(map.get(id1)!.replay_consumed).toBe(true);
    expect(allowsAutoReplay(map.get(id1)!, { resume_policy: "explicit" })).toBe(false);
    // Second crash is unknown without auth → no auto-replay.
    expect(allowsAutoReplay(map.get(id2)!, { resume_policy: "explicit" })).toBe(false);
  });
});

describe("CR-M-072 budget/permit chain in workflow", () => {
  it("successful run creates runtime permits directory", async () => {
    process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER = "1";
    const root = await initializedProject("permit-chain");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-rb", ["n.md"]);
    try {
      await runRoundtable(root, plan("fake"), "permit-run");
    } finally {
      delete process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER;
    }
    const { stat } = await import("node:fs/promises");
    await expect(
      stat(path.join(root, ".research", "runtime", "permits", "fake"))
    ).resolves.toBeTruthy();
    const events = await readEvents(root);
    const started = events.find((e) => e.type === "invocation_started");
    expect(started).toBeDefined();
  });
});
