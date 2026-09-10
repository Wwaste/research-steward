import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProvider } from "../src/providers.js";
import { allowsAutoReplay, foldInvocations, makeInvocationId } from "../src/invocations.js";
import { initializedProject } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

async function makeShim(
  body: string
): Promise<{ shimPath: string; counterPath: string; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rs-fault-"));
  cleanup.push(dir);
  const counterPath = path.join(dir, "calls.txt");
  const shimPath = path.join(dir, "shim.sh");
  await writeFile(shimPath, `#!/bin/sh\necho called >> '${counterPath}'\n${body}\n`, "utf8");
  await chmod(shimPath, 0o755);
  return { shimPath, counterPath, dir };
}

async function withKimi<T>(shimPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env["RESEARCH_STEWARD_KIMI_PATH"];
  process.env["RESEARCH_STEWARD_KIMI_PATH"] = shimPath;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env["RESEARCH_STEWARD_KIMI_PATH"];
    else process.env["RESEARCH_STEWARD_KIMI_PATH"] = prev;
  }
}

const node = {
  id: "n1",
  actor_id: "a1",
  role: "analyst",
  adapter: "kimi" as const,
  model: "kimi-latest",
  brief: "b",
  depends_on: [],
  visibility: "shared" as const,
  can_adjudicate: false,
  timeout_ms: 8_000
};

describe("process-level fault injection (Task 2.2)", () => {
  it("timeout: sleeping shim is SIGTERMed once, PROVIDER_TIMEOUT", async () => {
    const { shimPath, counterPath } = await makeShim("sleep 30\nexit 0");
    const root = await initializedProject("timeout");
    await withKimi(shimPath, async () => {
      await expect(
        runProvider(
          { ...node, timeout_ms: 1_500 } as never,
          "prompt",
          root,
          10_000
        )
      ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    });
    const lines = (await readFile(counterPath, "utf8")).trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it("cancel: AbortSignal SIGTERMs a live process mid-run", async () => {
    const { shimPath, counterPath } = await makeShim("sleep 30\nexit 0");
    const root = await initializedProject("cancel");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500).unref();
    await withKimi(shimPath, async () => {
      await expect(
        runProvider({ ...node, timeout_ms: 10_000 } as never, "prompt", root, 10_000, {
          signal: controller.signal
        })
      ).rejects.toMatchObject({ code: "PROVIDER_CANCELLED" });
    });
    const lines = (await readFile(counterPath, "utf8")).trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it("crash: unknown is not auto-replayed for paid adapters (fold)", () => {
    const invId = makeInvocationId("r1", "n1", 1);
    const events = [
      {
        type: "invocation_started",
        run_id: "r1",
        actor: { id: "c", role: "coordinator" },
        status: "complete",
        summary: "s",
        metadata: {
          invocation_id: invId,
          run_id: "r1",
          node_id: "n1",
          attempt: 1,
          adapter: "kimi"
        },
        event_id: "e1",
        sequence: 1,
        created_at: "2026-09-11T00:00:00.000Z",
        project_id: "11111111-1111-4111-8111-111111111111",
        event_hash: "a".repeat(64),
        previous_event_hash: null
      },
      {
        type: "invocation_unknown",
        run_id: "r1",
        actor: { id: "c", role: "coordinator" },
        status: "complete",
        summary: "s",
        metadata: {
          invocation_id: invId,
          marked_at_resume: true,
          prior_state: "started"
        },
        event_id: "e2",
        sequence: 2,
        created_at: "2026-09-11T00:00:01.000Z",
        project_id: "11111111-1111-4111-8111-111111111111",
        event_hash: "b".repeat(64),
        previous_event_hash: "a".repeat(64)
      }
    ] as never;
    const snap = foldInvocations(events as never).get(invId)!;
    expect(allowsAutoReplay(snap, { resume_policy: "never" })).toBe(false);
    expect(allowsAutoReplay(snap, { resume_policy: "fake_only" })).toBe(false);
  });
});
