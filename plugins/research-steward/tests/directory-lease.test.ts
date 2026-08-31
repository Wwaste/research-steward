import { mkdtemp, mkdir, readFile as realReadFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const readGate = vi.hoisted(() => ({
  next: null as null | { started: () => void; wait: Promise<void> }
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const contents = await actual.readFile(...args);
      const gate = readGate.next;
      if (gate && String(args[0]).endsWith(`${path.sep}owner.json`)) {
        readGate.next = null;
        gate.started();
        await gate.wait;
      }
      return contents;
    }
  };
});

import { acquireDirectoryLease } from "../src/directory-lease.js";

function options(root: string) {
  return {
    root,
    relative_path: ".research/runs/release-race/.lease",
    stale_ms: 100,
    heartbeat_ms: 60_000,
    attempts: 8,
    wait_ms: 0,
    active_error: () => new Error("active") as never,
    exhausted_error: () => new Error("exhausted") as never
  };
}

describe("directory lease generation fencing", () => {
  it("does not let a delayed predecessor release delete a successor lease", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "research-steward-lease-test-"));
    await mkdir(path.join(root, ".research", "runs", "release-race"), {
      recursive: true,
      mode: 0o700
    });
    const first = await acquireDirectoryLease(options(root));
    const leasePath = path.join(root, ".research", "runs", "release-race", ".lease");
    const stale = new Date(Date.now() - 5_000);
    await utimes(leasePath, stale, stale);

    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let resumeRelease!: () => void;
    const releaseMayContinue = new Promise<void>((resolve) => {
      resumeRelease = resolve;
    });
    readGate.next = { started: markReadStarted, wait: releaseMayContinue };

    const delayedRelease = first.release();
    await readStarted;
    const successor = await acquireDirectoryLease(options(root));
    resumeRelease();
    await delayedRelease;

    await expect(successor.assertOwned()).resolves.toBeUndefined();
    await expect(realReadFile(path.join(leasePath, "owner.json"), "utf8")).resolves.toContain(
      "owner_token"
    );
    await successor.release();
  });
});
