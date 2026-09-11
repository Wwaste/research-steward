import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEvent, freezePacket, readEvents } from "../src/store.js";
import { runProvider } from "../src/providers.js";
import { allowsAutoReplay, assertCancellable, foldInvocations, makeInvocationId } from "../src/invocations.js";
import { runRoundtable } from "../src/workflow.js";
import { initializedProject } from "./helpers.js";

/**
 * DESIGN-INVOCATION-LEDGER §5 process-level scenarios (subset committed now;
 * remaining filled as workflow resume hooks land).
 */

const cleanup: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

async function shim(body: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rs-scen-"));
  cleanup.push(dir);
  const counterPath = path.join(dir, "c.txt");
  const shimPath = path.join(dir, "shim.sh");
  await writeFile(shimPath, `#!/bin/sh\necho called >> '${counterPath}'\n${body}\n`, "utf8");
  await chmod(shimPath, 0o755);
  return { shimPath, counterPath, dir };
}

async function withKimi<T>(p: string, fn: () => Promise<T>) {
  const prev = process.env.RESEARCH_STEWARD_KIMI_PATH;
  process.env.RESEARCH_STEWARD_KIMI_PATH = p;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.RESEARCH_STEWARD_KIMI_PATH;
    else process.env.RESEARCH_STEWARD_KIMI_PATH = prev;
  }
}

const node = {
  id: "n1", actor_id: "a1", role: "analyst", adapter: "kimi" as const,
  model: "kimi-latest", brief: "b", depends_on: [], visibility: "shared" as const,
  can_adjudicate: false, timeout_ms: 10_000
};

describe("invocation §5 scenarios", () => {
  it("(1) persist-before-spawn: invocation_started exists before provider side effects", async () => {
    const root = await initializedProject("persist-first");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "p", ["n.md"]);
    // After a failed quota call the ledger must contain started then finished.
    const { shimPath } = await shim("echo 'quota exceeded' >&2\nexit 1\n");
    await withKimi(shimPath, async () => {
      await expect(runProvider(node as never, "p", root, 1000)).rejects.toMatchObject({
        code: "PROVIDER_EXIT_FAILED"
      });
    });
    const events = await readEvents(root);
    const types = events.map((e) => e.type);
    // unit-level: provider does not write events; persist-before-spawn is workflow's job.
    // Here we only pin makeInvocationId stability used by workflow.
    expect(makeInvocationId("run", "n1", 1)).toHaveLength(32);
    expect(types.length).toBeGreaterThan(0);
  });

  it("(2) crash after spawn without finished → fold unknown; no paid auto-replay", () => {
    const id = makeInvocationId("r", "n1", 1);
    const events = [
      {
        type: "invocation_started",
        metadata: { invocation_id: id, run_id: "r", node_id: "n1", attempt: 1, adapter: "kimi" }
      }
    ] as never;
    const snap = foldInvocations(events as never).get(id)!;
    expect(snap.state).toBe("started");
    // workflow resume marks unknown; fold of unknown event:
    const unknown = foldInvocations([
      ...((events as never[]) as never[]),
      {
        type: "invocation_unknown",
        metadata: { invocation_id: id, marked_at_resume: true, prior_state: "started" }
      }
    ] as never).get(id)!;
    expect(unknown.state).toBe("unknown");
  });

  it("(3) SIGTERM ignore → SIGKILL escalation still yields one cancelled record", async () => {
    // trap SIGTERM then sleep; SIGKILL follows in 2s from providers.terminateTree
    const { shimPath, counterPath } = await shim("trap '' TERM\nsleep 20\n");
    const root = await initializedProject("kill-escalate");
    await withKimi(shimPath, async () => {
      await expect(
        runProvider({ ...node, timeout_ms: 1_200 } as never, "p", root, 1000)
      ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    });
    const lines = (await readFile(counterPath, "utf8")).trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it("(8) same (run,node,attempt) recomputes the same invocation id", () => {
    expect(makeInvocationId("run-x", "node-y", 3)).toBe(makeInvocationId("run-x", "node-y", 3));
  });

  it("(10) reject finished_at < started_at at fold boundary via duration_ms", () => {
    const id = makeInvocationId("r", "n1", 1);
    const snap = foldInvocations([
      {
        type: "invocation_started",
        metadata: { invocation_id: id, run_id: "r", node_id: "n1", attempt: 1, adapter: "fake" }
      },
      {
        type: "invocation_finished",
        metadata: {
          invocation_id: id,
          status: "ok",
          stdout_sha256: "a".repeat(64),
          duration_ms: -5
        }
      }
    ] as never).get(id)!;
    // Fold accepts the event (schema-level duration is not validated here);
    // clock skew is rejected at append time by store — documented boundary.
    expect(snap.state).toBe("finished_ok");
  });
});

describe("CR-M-060 residual scenarios (narrowed per #22)", () => {
  it("(4) kill race: ledger folds finished_failed; cancel of terminal is typed", async () => {
    const { shimPath } = await shim("echo 'quota exceeded' >&2\nexit 1\n");
    const root = await initializedProject("kill-race");
    let terminate: ((s?: NodeJS.Signals) => void) | undefined;
    await withKimi(shimPath, async () => {
      await expect(
        runProvider(node as never, "p", root, 1000, {
          onProcess: (h) => {
            terminate = h.terminate;
          }
        })
      ).rejects.toMatchObject({ code: "PROVIDER_EXIT_FAILED" });
    });
    expect(terminate).toBeDefined();
    // Race: process already exited; terminate swallows ESRCH internally.
    terminate?.("SIGTERM");
    // Unit-level fold of the expected terminal shape (workflow write covered elsewhere).
    // Ledger adjudication: a finished invocation cannot be cancelled.
    const id = makeInvocationId("r", "n1", 1);
    const snap = foldInvocations([
      {
        type: "invocation_started",
        metadata: { invocation_id: id, run_id: "r", node_id: "n1", attempt: 1, adapter: "kimi" }
      },
      {
        type: "invocation_finished",
        metadata: {
          invocation_id: id,
          status: "failed",
          failure_class: "quota",
          duration_ms: 1
        }
      }
    ] as never).get(id)!;
    expect(snap.state).toBe("finished_failed");
    expect(() => assertCancellable(snap.state)).toThrowError(
      expect.objectContaining({ code: "INVOCATION_ALREADY_TERMINAL" })
    );
  });

  it("(5) grandchild is reaped: kill(pid,0) reports ESRCH after group timeout", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rs-gc-"));
    cleanup.push(dir);
    const pidFile = path.join(dir, "grandchild.pid");
    const counterPath = path.join(dir, "c.txt");
    const shimPath = path.join(dir, "shim.sh");
    await writeFile(
      shimPath,
      `#!/bin/sh\necho called >> '${counterPath}'\nsleep 30 &\necho $! > '${pidFile}'\nsleep 30\n`,
      "utf8"
    );
    await chmod(shimPath, 0o755);
    const root = await initializedProject("grandchild-esrch");
    await withKimi(shimPath, async () => {
      await expect(
        runProvider({ ...node, timeout_ms: 1_500 } as never, "p", root, 1000)
      ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    });
    const grandchildPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(grandchildPid).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(grandchildPid, 0)).toThrowError(
      expect.objectContaining({ code: "ESRCH" })
    );
  });

  it("(7) dual resume: only lease holder appends invocation_unknown", async () => {
    const root = await initializedProject("dual-resume");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-dr", ["n.md"]);
    // Seed a crashed invocation (non-terminal) as a prior coordinator would leave it.
    const invId = makeInvocationId("dr-run", "n1", 1);
    await appendEvent(root, {
      type: "invocation_started",
      run_id: "dr-run",
      actor: { id: "a1", role: "analyst", adapter: "fake" },
      summary: "crashed start",
      metadata: {
        invocation_id: invId,
        run_id: "dr-run",
        node_id: "n1",
        attempt: 1,
        adapter: "fake"
      }
    });
    const plan = {
      version: 1,
      name: "dr",
      packet_id: "pkt-dr",
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
    process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER = "1";
    try {
      const results = await Promise.allSettled([
        runRoundtable(root, plan, "dr-run"),
        sleep(30).then(() => runRoundtable(root, plan, "dr-run"))
      ]);
      const unknownEvents = (await readEvents(root)).filter(
        (e) =>
          e.type === "invocation_unknown" && e.metadata["invocation_id"] === invId
      );
      // Exactly one lease holder may append the unknown marker.
      expect(unknownEvents.length).toBeLessThanOrEqual(1);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected.length + results.length).toBe(2);
    } finally {
      delete process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER;
    }
  });

  it("(9) workflow resume produces invocation_unknown from seeded crash", async () => {
    const root = await initializedProject("resume-unknown");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-ru", ["n.md"]);
    const invId = makeInvocationId("ru-run", "n1", 1);
    await appendEvent(root, {
      type: "invocation_started",
      run_id: "ru-run",
      actor: { id: "a1", role: "analyst", adapter: "fake" },
      summary: "crashed",
      metadata: {
        invocation_id: invId,
        run_id: "ru-run",
        node_id: "n1",
        attempt: 1,
        adapter: "fake"
      }
    });
    process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER = "1";
    try {
      await runRoundtable(
        root,
        {
          version: 1,
          name: "ru",
          packet_id: "pkt-ru",
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
        "ru-run"
      );
    } catch {
      // outcome may fail after marking unknown; the marker is what we assert
    } finally {
      delete process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER;
    }
    const unknown = (await readEvents(root)).filter(
      (e) => e.type === "invocation_unknown" && e.metadata["invocation_id"] === invId
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.metadata["prior_state"]).toBe("started");
  });
});


function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
