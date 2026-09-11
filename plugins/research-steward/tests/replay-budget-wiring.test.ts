import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendEvent, freezePacket, readEvents } from "../src/store.js";
import { runRoundtable } from "../src/workflow.js";
import { allowsAutoReplay, foldInvocations, makeInvocationId, nextAttempt } from "../src/invocations.js";
import { initializedProject } from "./helpers.js";

function plan(adapter: "fake" | "kimi" = "fake", extraLimits: Record<string, unknown> = {}) {
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
      max_failures: 1,
      ...extraLimits
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

  it("releases the permit when invocation_started append fails", async () => {
    process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER = "1";
    const root = await initializedProject("permit-leak");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-rb", ["n.md"]);
    const store = await import("../src/store.js");
    const original = store.appendEvent.bind(store);
    const spy = vi
      .spyOn(store, "appendEvent")
      .mockImplementation(async (projectRoot, draft) => {
        if ((draft as { type?: string }).type === "invocation_started") {
          throw new Error("simulated ledger write failure");
        }
        return original(projectRoot, draft);
      });
    try {
      await expect(runRoundtable(root, plan("fake"), "permit-leak")).rejects.toThrow(
        "simulated ledger write failure"
      );
    } finally {
      spy.mockRestore();
      delete process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER;
    }
    const slots = (
      await readdir(path.join(root, ".research", "runtime", "permits", "fake"))
    ).filter((name) => name.startsWith("slot-"));
    expect(slots).toEqual([]);
  });

  it("runRoundtable hits BUDGET_EXCEEDED when the paid window is already full", async () => {
    const root = await initializedProject("budget-e2e");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-rb", ["n.md"]);
    // Seed one paid start so used=1 >= budget_max_invocations=1.
    await appendEvent(root, {
      type: "invocation_started",
      run_id: "prior-run",
      actor: { id: "a0", role: "analyst", adapter: "kimi" },
      summary: "prior paid start",
      metadata: {
        invocation_id: makeInvocationId("prior-run", "n0", 1),
        run_id: "prior-run",
        node_id: "n0",
        attempt: 1,
        adapter: "kimi"
      }
    });
    const providers = await import("../src/providers.js");
    const spawn = vi.spyOn(providers, "runProvider");
    try {
      await expect(
        runRoundtable(
          root,
          plan("kimi", { budget_max_invocations: 1, budget_window_ms: 3_600_000 }),
          "budget-run"
        )
      ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });
});
