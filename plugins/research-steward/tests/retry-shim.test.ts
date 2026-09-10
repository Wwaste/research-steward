import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freezePacket, readEvents } from "../src/store.js";
import { runProvider } from "../src/providers.js";
import { runRoundtable } from "../src/workflow.js";
import { initializedProject } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeQuotaShim(): Promise<{ shimPath: string; counterPath: string; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rs-shim-"));
  cleanup.push(dir);
  const counterPath = path.join(dir, "calls.txt");
  const shimPath = path.join(dir, "fake-quota-cli.sh");
  // POSIX sh avoids shebang/node ESM issues under sealed spawn.
  await writeFile(
    shimPath,
    "#!/bin/sh\necho called >> '" + counterPath + "'\necho 'quota exceeded for this billing period' >&2\nexit 1\n",
    "utf8"
  );
  await chmod(shimPath, 0o755);
  return { shimPath, counterPath, dir };
}

async function withKimiPath<T>(shimPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env["RESEARCH_STEWARD_KIMI_PATH"];
  process.env["RESEARCH_STEWARD_KIMI_PATH"] = shimPath;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env["RESEARCH_STEWARD_KIMI_PATH"];
    else process.env["RESEARCH_STEWARD_KIMI_PATH"] = prev;
  }
}

describe("real shim quota (CR-M-046)", () => {
  it("runProvider classifies quota from real process stderr", async () => {
    const { shimPath, counterPath } = await makeQuotaShim();
    const root = await initializedProject("direct-shim");
    await withKimiPath(shimPath, async () => {
      await expect(
        runProvider(
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
            timeout_ms: 15_000
          } as never,
          "prompt",
          root,
          10_000
        )
      ).rejects.toMatchObject({
        code: "PROVIDER_EXIT_FAILED",
        details: expect.objectContaining({ failure_class: "quota" })
      });
    });
    const lines = (await readFile(counterPath, "utf8")).trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it("workflow starts the provider process exactly once for quota with retry_limit 2", async () => {
    const { shimPath, counterPath } = await makeQuotaShim();
    const root = await initializedProject("workflow-shim");
    await writeFile(path.join(root, "notes.md"), "x\n", "utf8");
    await freezePacket(root, "pkt-shim", ["notes.md"]);
    await withKimiPath(shimPath, async () => {
      const result = await runRoundtable(
        root,
        {
          version: 1,
          name: "shim",
          packet_id: "pkt-shim",
          mode: "open",
          limits: {
            max_parallel: 1,
            max_wall_time_ms: 1_800_000,
            max_prompt_chars: 20_000,
            max_output_chars: 10_000,
            retry_limit: 2,
            max_failures: 3
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
              timeout_ms: 30_000
            }
          ]
        } as never,
        "shim-quota"
      );
      expect(result.outcome).toBe("failed");
    });
    const lines = (await readFile(counterPath, "utf8")).trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const events = await readEvents(root);
    const failure = events.find(
      (e) => e.metadata && (e.metadata as Record<string, unknown>)["failure_class"] === "quota"
    );
    expect(failure).toBeDefined();
    expect(JSON.stringify(events)).not.toContain("quota exceeded");
    const meta = failure!.metadata as Record<string, unknown>;
    expect(Array.isArray(meta["attempt_evidence"])).toBe(true);
    const evidence = meta["attempt_evidence"] as Array<Record<string, unknown>>;
    expect(evidence.length).toBeGreaterThanOrEqual(1);
    expect(evidence[0]!["failure_class"]).toBe("quota");
    expect(evidence[0]!["invocation_id"]).toMatch(/^[a-f0-9]{32}$/);
    expect(typeof evidence[0]!["retry_reason"]).toBe("string");
    expect(evidence[0]!["retry"]).toBe(false);
  });
});
