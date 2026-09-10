import { describe, expect, it } from "vitest";
import {
  allowsAutoReplay,
  confirmCancelled,
  finishInvocation,
  makeInvocationId,
  markUnknownAfterCrash,
  requestCancel,
  startInvocation
} from "../src/invocations.js";

describe("invocations (Task 2.2 module)", () => {
  it("is stable per run/node/attempt", () => {
    expect(makeInvocationId("r", "n", 1)).toBe(makeInvocationId("r", "n", 1));
    expect(makeInvocationId("r", "n", 1)).not.toBe(makeInvocationId("r", "n", 2));
  });

  it("walks started → finished with failure class and hash only", () => {
    const started = startInvocation({
      run_id: "r",
      node_id: "n",
      attempt: 1,
      provider: "fake"
    });
    const done = finishInvocation(started, {
      status: "failed",
      failure_class: "quota",
      stdout_sha256: "a".repeat(64)
    });
    expect(done.state).toBe("finished");
    expect(done.failure_class).toBe("quota");
    expect(done.stdout_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => finishInvocation(done, { status: "ok" })).toThrowError(
      expect.objectContaining({ code: "INVOCATION_ALREADY_TERMINAL" })
    );
  });

  it("cancel path and crash → unknown without paid auto-replay", () => {
    let inv = startInvocation({ run_id: "r", node_id: "n", attempt: 1, provider: "kimi" });
    inv = requestCancel(inv);
    inv = confirmCancelled(inv);
    expect(inv.state).toBe("cancelled");

    const crashed = markUnknownAfterCrash(
      startInvocation({ run_id: "r", node_id: "n", attempt: 2, provider: "kimi" })
    );
    expect(crashed.state).toBe("unknown");
    expect(allowsAutoReplay(crashed, { resume_policy: "never" })).toBe(false);
    expect(allowsAutoReplay(crashed, { resume_policy: "fake_only" })).toBe(false);
    const fakeCrash = markUnknownAfterCrash(
      startInvocation({ run_id: "r", node_id: "n", attempt: 3, provider: "fake" })
    );
    expect(allowsAutoReplay(fakeCrash, { resume_policy: "fake_only" })).toBe(true);
  });
});
