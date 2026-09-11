import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendEvent, freezePacket, readEvents } from "../src/store.js";
import { runRoundtable } from "../src/workflow.js";
import { countPaidInvocationsInWindow } from "../src/budget-permits.js";
import { foldInvocations, makeInvocationId } from "../src/invocations.js";
import { ResearchStewardError } from "../src/utils.js";
import { initializedProject } from "./helpers.js";

describe("CR-M-067 no paid replay after unknown", () => {
  it("does not spawn when a prior invocation is unknown without authorization", async () => {
    const root = await initializedProject("no-replay");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-nr", ["n.md"]);
    // Seed a crashed invocation as if a prior coordinator died mid-call.
    const invId = makeInvocationId("nr-run", "n1", 1);
    await appendEvent(root, {
      type: "invocation_started",
      run_id: "nr-run",
      actor: { id: "a1", role: "analyst", adapter: "kimi" },
      summary: "started",
      metadata: {
        invocation_id: invId,
        run_id: "nr-run",
        node_id: "n1",
        attempt: 1,
        adapter: "kimi"
      }
    });
    await appendEvent(root, {
      type: "invocation_unknown",
      run_id: "nr-run",
      actor: { id: "research-steward", role: "coordinator" },
      summary: "unknown",
      metadata: {
        invocation_id: invId,
        marked_at_resume: true,
        prior_state: "started"
      }
    });
    const spawn = vi.spyOn(await import("../src/providers.js"), "runProvider");
    const result = await runRoundtable(
      root,
      {
        version: 1,
        name: "nr",
        packet_id: "pkt-nr",
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
            adapter: "kimi",
            model: "kimi-latest",
            brief: "b",
            depends_on: [],
            visibility: "shared",
            can_adjudicate: false,
            timeout_ms: 5_000
          }
        ]
      } as never,
      "nr-run"
    );
    expect(spawn).not.toHaveBeenCalled();
    const events = await readEvents(root);
    const failed = events.find(
      (e) =>
        e.type === "agent_contribution" &&
        e.metadata["node_id"] === "n1" &&
        e.metadata["blocked_by"] === "unknown_outcome"
    );
    expect(failed).toBeDefined();
    expect(result.outcome).toBe("failed");
  });
});

describe("CR-M-068 budget counts production timestamp", () => {
  it("counts real appendEvent events by timestamp field", async () => {
    const root = await initializedProject("budget-ts");
    const ev = await appendEvent(root, {
      type: "invocation_started",
      actor: { id: "a1", role: "analyst", adapter: "kimi" },
      summary: "s",
      metadata: {
        invocation_id: "a".repeat(32),
        run_id: "r",
        node_id: "n1",
        attempt: 1,
        adapter: "kimi"
      }
    });
    expect(typeof (ev as { timestamp: string }).timestamp).toBe("string");
    const n = countPaidInvocationsInWindow(
      [ev],
      "2000-01-01T00:00:00.000Z",
      ["kimi"]
    );
    expect(n).toBe(1);
  });

  it("new invocation_started does not overwrite unknown (fold)", () => {
    const id = makeInvocationId("r", "n1", 1);
    const snap = foldInvocations([
      {
        type: "invocation_started",
        metadata: { invocation_id: id, run_id: "r", node_id: "n1", attempt: 1, adapter: "kimi" }
      },
      {
        type: "invocation_unknown",
        metadata: { invocation_id: id, marked_at_resume: true, prior_state: "started" }
      },
      {
        type: "invocation_started",
        metadata: { invocation_id: id, run_id: "r", node_id: "n1", attempt: 1, adapter: "kimi" }
      }
    ] as never).get(id)!;
    expect(snap.state).toBe("unknown");
  });
});
