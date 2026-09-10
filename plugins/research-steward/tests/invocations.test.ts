import { describe, expect, it } from "vitest";
import {
  allowsAutoReplay,
  assertCancellable,
  foldInvocations,
  isTerminal,
  makeInvocationId,
  type InvocationSnapshot
} from "../src/invocations.js";
import type { CommittedEvent } from "../src/protocol.js";

function ev(
  type: CommittedEvent["type"],
  metadata: Record<string, unknown>,
  sequence = 1
): CommittedEvent {
  return {
    event_id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sequence,
    created_at: "2026-09-11T00:00:00.000Z",
    project_id: "11111111-1111-4111-8111-111111111111",
    type,
    actor: { id: "coordinator", role: "coordinator" },
    status: "complete",
    summary: type,
    metadata,
    event_hash: "a".repeat(64),
    previous_event_hash: null
  } as unknown as CommittedEvent;
}

const id = makeInvocationId("run-1", "n1", 1);

describe("invocation ledger fold (DESIGN-INVOCATION-LEDGER step 2)", () => {
  it("stable ids with newline separator (no | collision)", () => {
    expect(makeInvocationId("run-1", "n1", 1)).toBe(id);
    expect(makeInvocationId("run-1", "n1", 2)).not.toBe(id);
    // "ab|c" cannot be produced by IdentifierSchema ids, and newline split is unique
    expect(makeInvocationId("run-1", "n1", 1)).not.toBe(makeInvocationId("run", "1-n1", 1));
  });

  it("folds started → finished_ok", () => {
    const map = foldInvocations([
      ev("invocation_started", {
        invocation_id: id,
        run_id: "run-1",
        node_id: "n1",
        attempt: 1,
        adapter: "kimi"
      }),
      ev("invocation_finished", {
        invocation_id: id,
        status: "ok",
        stdout_sha256: "b".repeat(64),
        duration_ms: 10
      }, 2)
    ]);
    expect(map.get(id)!.state).toBe("finished_ok");
    expect(map.get(id)!.stdout_sha256).toBe("b".repeat(64));
  });

  it("CR-M-051: unknown cannot be cancelled", () => {
    const map = foldInvocations([
      ev("invocation_started", {
        invocation_id: id,
        run_id: "run-1",
        node_id: "n1",
        attempt: 1,
        adapter: "kimi"
      }),
      ev("invocation_unknown", {
        invocation_id: id,
        marked_at_resume: true,
        prior_state: "started"
      }, 2)
    ]);
    const snap = map.get(id)!;
    expect(snap.state).toBe("unknown");
    expect(() => assertCancellable(snap.state)).toThrowError(
      expect.objectContaining({ code: "INVOCATION_OUTCOME_UNKNOWN" })
    );
    expect(allowsAutoReplay(snap, { resume_policy: "never" })).toBe(false);
    expect(allowsAutoReplay(snap, { resume_policy: "fake_only" })).toBe(false);
    expect(allowsAutoReplay(snap, { resume_policy: "explicit" })).toBe(false);
  });

  it("explicit replay requires authorization event", () => {
    const map = foldInvocations([
      ev("invocation_started", {
        invocation_id: id,
        run_id: "run-1",
        node_id: "n1",
        attempt: 1,
        adapter: "kimi"
      }),
      ev("invocation_unknown", {
        invocation_id: id,
        marked_at_resume: true,
        prior_state: "started"
      }, 2),
      ev("invocation_replay_authorized", {
        invocation_id: id,
        authority: "human-lead",
        note: "ok to retry"
      }, 3)
    ]);
    const snap = map.get(id)!;
    expect(snap.replay_authorized).toBe(true);
    expect(allowsAutoReplay(snap, { resume_policy: "explicit" })).toBe(true);
  });

  it("finished wins over a late cancel", () => {
    const map = foldInvocations([
      ev("invocation_started", {
        invocation_id: id,
        run_id: "run-1",
        node_id: "n1",
        attempt: 1,
        adapter: "fake"
      }),
      ev("invocation_finished", {
        invocation_id: id,
        status: "failed",
        failure_class: "quota",
        duration_ms: 5
      }, 2),
      ev("invocation_cancelled", {
        invocation_id: id,
        kill_confirmed: true
      }, 3)
    ]);
    expect(map.get(id)!.state).toBe("finished_failed");
    expect(isTerminal(map.get(id)!.state)).toBe(true);
  });
});
