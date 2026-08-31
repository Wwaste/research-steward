import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommittedEvent } from "../src/protocol.js";
import {
  buildLedgerIndex,
  readEventsWithIndex,
  writeLedgerIndex,
  type LedgerIndex
} from "../src/ledger-index.js";
import { appendEvent, readEvents } from "../src/store.js";
import { sha256Text, stableJson } from "../src/utils.js";
import {
  eventFiles,
  expectErrorCode,
  initializedProject,
  temporaryDirectory
} from "./helpers.js";

const INDEX_RELATIVE_PATH = path.join(".research", "cache", "ledger-index.json");

async function appendSimpleEvents(root: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await appendEvent(root, {
      type: "candidate_declared",
      actor: { id: "index-fixture", role: "author" },
      summary: `Fixture event ${index + 1}.`
    });
  }
}

/** Initialized project whose ledger holds exactly `total` committed events. */
async function projectWithEvents(total: number): Promise<string> {
  const root = await initializedProject("Ledger index test");
  await appendSimpleEvents(root, total - 1);
  return root;
}

async function readIndexFile(root: string): Promise<LedgerIndex> {
  return JSON.parse(
    await readFile(path.join(root, INDEX_RELATIVE_PATH), "utf8")
  ) as LedgerIndex;
}

async function writeRawIndexFile(root: string, contents: string): Promise<void> {
  await mkdir(path.join(root, ".research", "cache"), { recursive: true });
  await writeFile(path.join(root, INDEX_RELATIVE_PATH), contents, "utf8");
}

async function tamperEventSummary(root: string, sequence: number): Promise<void> {
  const name = (await eventFiles(root))[sequence - 1]!;
  const eventPath = path.join(root, ".research", "events", name);
  const event = JSON.parse(await readFile(eventPath, "utf8")) as CommittedEvent;
  event.summary = `${event.summary} [tampered]`;
  await writeFile(eventPath, `${JSON.stringify(event, null, 2)}\n`, "utf8");
}

/**
 * Build a schema-valid ledger without going through appendEvent, so large
 * event counts stay fast. The bytes are indistinguishable from committed
 * events: full hash chain, contiguous sequences, and an anchored head.
 */
async function syntheticProject(eventCount: number): Promise<string> {
  const root = await temporaryDirectory();
  const projectId = randomUUID();
  await mkdir(path.join(root, ".research", "events"), { recursive: true });
  await writeFile(
    path.join(root, ".research", "manifest.json"),
    `${JSON.stringify(
      {
        protocol_version: "1.0",
        project_id: projectId,
        title: "Synthetic ledger",
        created_at: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  let previousHash: string | null = null;
  for (let sequence = 1; sequence <= eventCount; sequence += 1) {
    const withoutHash = {
      type: "candidate_declared",
      run_id: undefined,
      actor: { id: "synthetic-generator", role: "author" },
      input_hash: undefined,
      depends_on: [],
      visibility: "shared",
      status: "complete",
      summary: `Synthetic event ${sequence}.`,
      uncertainties: [],
      evidence: [],
      findings: [],
      decisions: [],
      metadata: {},
      protocol_version: "1.0",
      event_id: randomUUID(),
      sequence,
      timestamp: new Date().toISOString(),
      project_id: projectId,
      previous_event_hash: previousHash
    };
    const eventHash = sha256Text(stableJson(withoutHash));
    previousHash = eventHash;
    await writeFile(
      path.join(
        root,
        ".research",
        "events",
        `${String(sequence).padStart(8, "0")}-${withoutHash.event_id}.json`
      ),
      `${JSON.stringify({ ...withoutHash, event_hash: eventHash }, null, 2)}\n`,
      "utf8"
    );
  }
  const headWithoutHash = {
    version: 1,
    project_id: projectId,
    event_count: eventCount,
    last_sequence: eventCount,
    last_event_hash: previousHash
  };
  await writeFile(
    path.join(root, ".research", "ledger-head.json"),
    `${JSON.stringify(
      { ...headWithoutHash, head_hash: sha256Text(stableJson(headWithoutHash)) },
      null,
      2
    )}\n`,
    "utf8"
  );
  return root;
}

describe("buildLedgerIndex", () => {
  it("places a checkpoint at every interval boundary and always at the last event", async () => {
    const root = await projectWithEvents(12);
    const events = await readEvents(root);
    const index = await buildLedgerIndex(root, 5);

    expect(index.index_version).toBe(1);
    expect(index.project_id).toBe(events[0]!.project_id);
    expect(index.checkpoints.map((checkpoint) => checkpoint.sequence)).toEqual([5, 10, 12]);
    for (const checkpoint of index.checkpoints) {
      const event = events[checkpoint.sequence - 1]!;
      expect(checkpoint.event_id).toBe(event.event_id);
      expect(checkpoint.event_hash).toBe(event.event_hash);
      expect(checkpoint.cumulative_count).toBe(event.sequence);
    }
  });

  it("does not duplicate the final checkpoint when the last event falls on an interval boundary", async () => {
    const root = await projectWithEvents(10);
    const index = await buildLedgerIndex(root, 5);
    expect(index.checkpoints.map((checkpoint) => checkpoint.sequence)).toEqual([5, 10]);
  });

  it("rejects a non-positive or fractional checkpoint interval", async () => {
    const root = await projectWithEvents(1);
    await expectErrorCode(buildLedgerIndex(root, 0), "INVALID_CHECKPOINT_INTERVAL");
    await expectErrorCode(buildLedgerIndex(root, 2.5), "INVALID_CHECKPOINT_INTERVAL");
  });
});

describe("writeLedgerIndex and readEventsWithIndex", () => {
  it("behaves exactly like readEvents when no index exists", async () => {
    const root = await projectWithEvents(3);
    const events = await readEventsWithIndex(root);
    expect(events).toEqual(await readEvents(root));
  });

  it("writes the cache file and returns fully verified events with a fresh index", async () => {
    const root = await projectWithEvents(12);
    await writeLedgerIndex(root, await buildLedgerIndex(root, 5));

    const info = await stat(path.join(root, INDEX_RELATIVE_PATH));
    expect(info.isFile()).toBe(true);
    expect(await readEventsWithIndex(root)).toEqual(await readEvents(root));
  });

  it("still fails with the store's hash-chain error when a middle event is tampered", async () => {
    const root = await projectWithEvents(12);
    await writeLedgerIndex(root, await buildLedgerIndex(root, 5));
    await tamperEventSummary(root, 7);
    await expectErrorCode(readEventsWithIndex(root), "EVENT_HASH_MISMATCH");
  });

  it("fails closed with STALE_LEDGER_INDEX when an index checkpoint is tampered", async () => {
    const root = await projectWithEvents(12);
    await writeLedgerIndex(root, await buildLedgerIndex(root, 5));
    const index = await readIndexFile(root);
    index.checkpoints[0]!.event_hash = "0".repeat(64);
    await writeRawIndexFile(root, `${JSON.stringify(index, null, 2)}\n`);
    await expectErrorCode(readEventsWithIndex(root), "STALE_LEDGER_INDEX");
  });

  it("reports a lagging index as stale instead of silently rebuilding it", async () => {
    const root = await projectWithEvents(6);
    await writeLedgerIndex(root, await buildLedgerIndex(root, 5));
    await appendSimpleEvents(root, 1);

    const before = await readFile(path.join(root, INDEX_RELATIVE_PATH), "utf8");
    await expectErrorCode(readEventsWithIndex(root), "STALE_LEDGER_INDEX");
    const after = await readFile(path.join(root, INDEX_RELATIVE_PATH), "utf8");
    expect(after).toBe(before);
  });

  it("treats a corrupt index file as stale rather than trusting or repairing it", async () => {
    const root = await projectWithEvents(3);
    await writeRawIndexFile(root, "{ not valid json");
    await expectErrorCode(readEventsWithIndex(root), "STALE_LEDGER_INDEX");
  });

  it("lets a deleted index be rebuilt explicitly", async () => {
    const root = await projectWithEvents(12);
    await writeLedgerIndex(root, await buildLedgerIndex(root, 5));
    await rm(path.join(root, INDEX_RELATIVE_PATH));

    expect(await readEventsWithIndex(root)).toEqual(await readEvents(root));

    await writeLedgerIndex(root, await buildLedgerIndex(root, 5));
    const rebuilt = await readIndexFile(root);
    expect(rebuilt.checkpoints.map((checkpoint) => checkpoint.sequence)).toEqual([5, 10, 12]);
    expect(await readEventsWithIndex(root)).toEqual(await readEvents(root));
  });
});

describe("performance smoke", () => {
  it("indexes 1000 synthetic events at the default 500-event interval", async () => {
    const root = await syntheticProject(1000);
    const startedAt = performance.now();
    const index = await buildLedgerIndex(root);
    const elapsedMs = performance.now() - startedAt;
    // Smoke only: print the duration, never assert a threshold here.
    console.log(`buildLedgerIndex over 1000 events took ${elapsedMs.toFixed(1)} ms`);
    expect(index.checkpoints.map((checkpoint) => checkpoint.sequence)).toEqual([500, 1000]);
    expect(index.checkpoints.at(-1)?.cumulative_count).toBe(1000);
  });
});

describe("index cache edge cases", () => {
  it("treats a directory at the index path as stale instead of failing with a raw filesystem error", async () => {
    const root = await projectWithEvents(3);
    await mkdir(path.join(root, INDEX_RELATIVE_PATH), { recursive: true });
    await expectErrorCode(readEventsWithIndex(root), "STALE_LEDGER_INDEX");
  });

  it("supports a checkpoint interval of 1", async () => {
    const root = await projectWithEvents(3);
    const index = await buildLedgerIndex(root, 1);
    expect(index.checkpoints.map((checkpoint) => checkpoint.sequence)).toEqual([1, 2, 3]);
    for (const checkpoint of index.checkpoints) {
      expect(checkpoint.cumulative_count).toBe(checkpoint.sequence);
    }
    await writeLedgerIndex(root, index);
    expect(await readEventsWithIndex(root)).toEqual(await readEvents(root));
  });

  it("catches a rolled-back ledger tail that a rewritten head alone would accept", async () => {
    const root = await projectWithEvents(12);
    await writeLedgerIndex(root, await buildLedgerIndex(root, 5));
    const names = await eventFiles(root);

    // Deleting only the tail event trips the durable head anchor first.
    await rm(path.join(root, ".research", "events", names.at(-1)!));
    await expectErrorCode(readEventsWithIndex(root), "LEDGER_HEAD_MISMATCH");

    // Rewrite the head to the truncated 11-event state: the chain and head
    // now agree, and only the index still remembers the deleted tail.
    const newTail = JSON.parse(
      await readFile(path.join(root, ".research", "events", names.at(-2)!), "utf8")
    ) as CommittedEvent;
    const headWithoutHash = {
      version: 1,
      project_id: newTail.project_id,
      event_count: 11,
      last_sequence: 11,
      last_event_hash: newTail.event_hash
    };
    await writeFile(
      path.join(root, ".research", "ledger-head.json"),
      `${JSON.stringify(
        { ...headWithoutHash, head_hash: sha256Text(stableJson(headWithoutHash)) },
        null,
        2
      )}\n`,
      "utf8"
    );
    expect(await readEvents(root)).toHaveLength(11);
    await expectErrorCode(readEventsWithIndex(root), "STALE_LEDGER_INDEX");
  });

  it("rejects an index copied from a different project", async () => {
    const rootA = await projectWithEvents(3);
    const rootB = await projectWithEvents(3);
    await writeLedgerIndex(rootB, await buildLedgerIndex(rootA, 5));
    await expectErrorCode(readEventsWithIndex(rootB), "STALE_LEDGER_INDEX");
  });
});
