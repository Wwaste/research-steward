import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendEvent, freezePacket, readEvents } from "../src/store.js";
import { runRoundtable } from "../src/workflow.js";
import {
  authorizeReplay,
  foldInvocations,
  makeInvocationId
} from "../src/invocations.js";
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

async function seedCrashedStart(root: string, runId: string, attempt: number) {
  const id = makeInvocationId(runId, "n1", attempt);
  await appendEvent(root, {
    type: "invocation_started",
    run_id: runId,
    actor: { id: "a1", role: "analyst", adapter: "fake" },
    summary: "crashed start",
    metadata: {
      invocation_id: id,
      run_id: runId,
      node_id: "n1",
      attempt,
      adapter: "fake",
      command_sha256: "a".repeat(64)
    }
  });
  return id;
}

describe("CR-M-071 authorizeReplay fold-first entry (#45)", () => {
  it("rejects a missing invocation with INVOCATION_NOT_FOUND and writes nothing", async () => {
    const root = await initializedProject("auth-missing");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-c", ["n.md"]);
    const before = (await readEvents(root)).length;
    await expect(
      authorizeReplay(root, {
        run_id: "no-run",
        invocation_id: "c".repeat(32),
        authority: "human-lead",
        target_attempt: 2
      })
    ).rejects.toMatchObject({ code: "INVOCATION_NOT_FOUND" });
    expect((await readEvents(root)).length).toBe(before);
  });

  it("rejects a terminal invocation with INVOCATION_ALREADY_TERMINAL", async () => {
    const root = await initializedProject("auth-terminal");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-c", ["n.md"]);
    const id = makeInvocationId("t-run", "n1", 1);
    await appendEvent(root, {
      type: "invocation_started",
      run_id: "t-run",
      actor: { id: "a1", role: "analyst", adapter: "fake" },
      summary: "s",
      metadata: {
        invocation_id: id,
        run_id: "t-run",
        node_id: "n1",
        attempt: 1,
        adapter: "fake",
        command_sha256: "a".repeat(64)
      }
    });
    await appendEvent(root, {
      type: "invocation_finished",
      run_id: "t-run",
      actor: { id: "a1", role: "analyst" },
      summary: "failed",
      metadata: {
        invocation_id: id,
        status: "failed",
        failure_class: "unknown",
        duration_ms: 1
      }
    });
    const before = (await readEvents(root)).length;
    await expect(
      authorizeReplay(root, {
        run_id: "t-run",
        invocation_id: id,
        authority: "human-lead",
        target_attempt: 2
      })
    ).rejects.toMatchObject({ code: "INVOCATION_ALREADY_TERMINAL" });
    expect((await readEvents(root)).length).toBe(before);
  });

  it("marks a still-started invocation unknown, then authorizes", async () => {
    const root = await initializedProject("auth-mark");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-c", ["n.md"]);
    const id = await seedCrashedStart(root, "m-run", 1);
    await authorizeReplay(root, {
      run_id: "m-run",
      invocation_id: id,
      authority: "human-lead",
      target_attempt: 2
    });
    const events = await readEvents(root);
    const unknown = events.find(
      (e) => e.type === "invocation_unknown" && e.metadata["invocation_id"] === id
    );
    const auth = events.find(
      (e) => e.type === "invocation_replay_authorized" && e.metadata["invocation_id"] === id
    );
    expect(unknown).toBeDefined();
    expect(unknown!.metadata["prior_state"]).toBe("started");
    expect(auth).toBeDefined();
    const fold = foldInvocations(events.filter((e) => e.run_id === "m-run"));
    expect(fold.get(id)!.state).toBe("unknown");
    expect(fold.get(id)!.replay_authorized).toBe(true);
  });

  it("authorizes an already-unknown invocation without a second unknown", async () => {
    const root = await initializedProject("auth-unknown");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-c", ["n.md"]);
    const id = await seedCrashedStart(root, "u-run", 1);
    await appendEvent(root, {
      type: "invocation_unknown",
      run_id: "u-run",
      actor: { id: "research-steward", role: "coordinator" },
      summary: "u",
      metadata: { invocation_id: id, marked_at_resume: true, prior_state: "started" }
    });
    await authorizeReplay(root, {
      run_id: "u-run",
      invocation_id: id,
      authority: "human-lead",
      target_attempt: 2
    });
    const events = await readEvents(root);
    expect(
      events.filter((e) => e.type === "invocation_unknown" && e.metadata["invocation_id"] === id)
    ).toHaveLength(1);
    expect(
      events.filter(
        (e) => e.type === "invocation_replay_authorized" && e.metadata["invocation_id"] === id
      )
    ).toHaveLength(1);
  });
});

describe("CR-M-071 usable operator sequences", () => {
  it("crash → authorize → resume works without a manual unknown seed", async () => {
    process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER = "1";
    const root = await initializedProject("seq1");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-c", ["n.md"]);
    const id1 = await seedCrashedStart(root, "s1", 1);
    try {
      await authorizeReplay(root, {
        run_id: "s1",
        invocation_id: id1,
        authority: "human-lead",
        target_attempt: 2
      });
      const result = await runRoundtable(root, plan(), "s1");
      const id2 = makeInvocationId("s1", "n1", 2);
      const events = await readEvents(root);
      expect(
        events.some((e) => e.type === "invocation_started" && e.metadata["invocation_id"] === id2)
      ).toBe(true);
      expect(result.outcome).toBe("complete");
    } finally {
      delete process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER;
    }
  });

  it("crash → auth → resume → crash again → auth again → resume", async () => {
    process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER = "1";
    const root = await initializedProject("seq2");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-c", ["n.md"]);
    const id1 = await seedCrashedStart(root, "s2", 1);
    try {
      await authorizeReplay(root, {
        run_id: "s2",
        invocation_id: id1,
        authority: "human-lead",
        target_attempt: 2
      });
      // First resume would spawn attempt-2 via fake. Simulate its crash by
      // seeding only started for attempt-2 before a second authorize+resume.
      const id2 = makeInvocationId("s2", "n1", 2);
      await appendEvent(root, {
        type: "invocation_started",
        run_id: "s2",
        actor: { id: "a1", role: "analyst", adapter: "fake" },
        summary: "attempt2 crashed",
        metadata: {
          invocation_id: id2,
          run_id: "s2",
          node_id: "n1",
          attempt: 2,
          adapter: "fake",
          command_sha256: "a".repeat(64)
        }
      });
      await authorizeReplay(root, {
        run_id: "s2",
        invocation_id: id2,
        authority: "human-lead",
        target_attempt: 3
      });
      const result = await runRoundtable(root, plan(), "s2");
      const id3 = makeInvocationId("s2", "n1", 3);
      const events = await readEvents(root);
      expect(
        events.some((e) => e.type === "invocation_started" && e.metadata["invocation_id"] === id3)
      ).toBe(true);
      expect(result.outcome).toBe("complete");
    } finally {
      delete process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER;
    }
  });

  it("after attempt-2 also crashes, a second resume refuses replay without new auth", async () => {
    process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER = "1";
    const root = await initializedProject("consume");
    await writeFile(path.join(root, "n.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-c", ["n.md"]);
    const id1 = await seedCrashedStart(root, "c-run", 1);
    await authorizeReplay(root, {
      run_id: "c-run",
      invocation_id: id1,
      authority: "human-lead",
      target_attempt: 2
    });
    const id2 = makeInvocationId("c-run", "n1", 2);
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
        adapter: "fake",
        command_sha256: "a".repeat(64)
      }
    });
    let fold = foldInvocations((await readEvents(root)).filter((e) => e.run_id === "c-run"));
    expect(fold.get(id1)!.replay_consumed).toBe(true);

    const providers = await import("../src/providers.js");
    const spy = vi.spyOn(providers, "runProvider");
    try {
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
    } finally {
      spy.mockRestore();
      delete process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER;
    }
  });
});

describe("CR-M-071 CLI authorize-replay emitter", () => {
  it(
    "CLI authorize-replay is reachable, loud on dangling ids, and usable on a live crash",
    async () => {
      process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER = "1";
      const root = await initializedProject("cli-auth");
      await writeFile(path.join(root, "n.md"), "x\n", "utf8");
      await freezePacket(root, "pkt-c", ["n.md"]);
      const id1 = await seedCrashedStart(root, "cli-run", 1);
      const { fileURLToPath } = await import("node:url");
      const cliPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../dist/cli.mjs"
      );
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const runCli = async (args: string[]) => {
        try {
          const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
            cwd: root,
            env: { ...process.env, RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER: "1" }
          });
          return { code: 0, stdout };
        } catch (error) {
          const e = error as { code?: number; stdout?: string; stderr?: string };
          return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
        }
      };
      // Dangling id is loud.
      const dangling = await runCli([
        "authorize-replay",
        "--project",
        root,
        "--run-id",
        "cli-run",
        "--invocation",
        "d".repeat(32),
        "--authority",
        "human-lead",
        "--target-attempt",
        "2"
      ]);
      expect(dangling.code).not.toBe(0);
      expect(dangling.stderr ?? "").toContain("INVOCATION_NOT_FOUND");

      // Live crash: marks unknown + auth.
      const ok = await runCli([
        "authorize-replay",
        "--project",
        root,
        "--run-id",
        "cli-run",
        "--invocation",
        id1,
        "--authority",
        "human-lead",
        "--target-attempt",
        "2"
      ]);
      expect(ok.code).toBe(0);
      const events = await readEvents(root);
      expect(
        events.some(
          (e) => e.type === "invocation_unknown" && e.metadata["invocation_id"] === id1
        )
      ).toBe(true);
      expect(
        events.some(
          (e) => e.type === "invocation_replay_authorized" && e.metadata["invocation_id"] === id1
        )
      ).toBe(true);
      const result = await runRoundtable(root, plan(), "cli-run");
      expect(result.outcome).toBe("complete");
      delete process.env.RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER;
    },
    60_000
  );
});
