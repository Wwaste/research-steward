import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import {
  ProjectManifestSchema,
  type CommittedEvent
} from "./protocol.js";
import {
  ensurePrivateDirectoryInside,
  resolvePrivateDestinationInside,
  resolvePrivateExistingInside
} from "./paths.js";
import { ResearchStewardError, atomicWriteFile, errorMessage } from "./utils.js";
import { readEvents } from "./store.js";

/**
 * The ledger index is a disposable cache. Authority always stays with the
 * per-event hash-chain verification in store.ts: readEventsWithIndex still
 * runs the full readEvents validation, and any disagreement between index and
 * ledger fails closed instead of being repaired silently.
 */

const INDEX_RELATIVE_PATH = ".research/cache/ledger-index.json";

export const DEFAULT_CHECKPOINT_INTERVAL = 500;

const LedgerIndexCheckpointSchema = z
  .object({
    sequence: z.number().int().positive(),
    event_id: z.string().uuid(),
    event_hash: z.string().regex(/^[a-f0-9]{64}$/),
    cumulative_count: z.number().int().positive()
  })
  .strict();

export const LedgerIndexSchema = z
  .object({
    index_version: z.literal(1),
    project_id: z.string().uuid(),
    checkpoints: z.array(LedgerIndexCheckpointSchema)
  })
  .strict();

export type LedgerIndexCheckpoint = z.infer<typeof LedgerIndexCheckpointSchema>;
export type LedgerIndex = z.infer<typeof LedgerIndexSchema>;

function staleIndexError(reason: string): ResearchStewardError {
  return new ResearchStewardError(
    "STALE_LEDGER_INDEX",
    `Ledger index cache does not match the verified ledger (${reason}). ` +
      `The index is never rebuilt silently: delete ${INDEX_RELATIVE_PATH} or rebuild it ` +
      "explicitly with buildLedgerIndex and writeLedgerIndex."
  );
}

export async function buildLedgerIndex(
  root: string,
  checkpointInterval = DEFAULT_CHECKPOINT_INTERVAL
): Promise<LedgerIndex> {
  if (!Number.isInteger(checkpointInterval) || checkpointInterval < 1) {
    throw new ResearchStewardError(
      "INVALID_CHECKPOINT_INTERVAL",
      "Checkpoint interval must be a positive integer."
    );
  }
  const manifestPath = await resolvePrivateExistingInside(root, ".research/manifest.json");
  const manifest = ProjectManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  // Full fail-closed validation: the index only ever summarizes a ledger that
  // just passed the complete hash-chain check.
  const events = await readEvents(root);

  const checkpoints: LedgerIndexCheckpoint[] = [];
  for (const [position, event] of events.entries()) {
    const cumulativeCount = position + 1;
    if (cumulativeCount % checkpointInterval === 0) {
      checkpoints.push({
        sequence: event.sequence,
        event_id: event.event_id,
        event_hash: event.event_hash,
        cumulative_count: cumulativeCount
      });
    }
  }
  const lastEvent = events.at(-1);
  if (lastEvent && checkpoints.at(-1)?.sequence !== lastEvent.sequence) {
    checkpoints.push({
      sequence: lastEvent.sequence,
      event_id: lastEvent.event_id,
      event_hash: lastEvent.event_hash,
      cumulative_count: events.length
    });
  }
  return LedgerIndexSchema.parse({
    index_version: 1,
    project_id: manifest.project_id,
    checkpoints
  });
}

export async function writeLedgerIndex(root: string, index: LedgerIndex): Promise<void> {
  let parsed: LedgerIndex;
  try {
    parsed = LedgerIndexSchema.parse(index);
  } catch (error) {
    throw new ResearchStewardError(
      "INVALID_LEDGER_INDEX",
      `Refusing to write a malformed ledger index: ${errorMessage(error)}`
    );
  }
  await ensurePrivateDirectoryInside(root, ".research/cache");
  const indexPath = await resolvePrivateDestinationInside(root, INDEX_RELATIVE_PATH);
  // atomicWriteFile may overwrite: unlike events, the index is only a cache.
  await atomicWriteFile(indexPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

async function readStoredIndex(root: string): Promise<LedgerIndex | null> {
  let raw: string;
  try {
    const indexPath = await resolvePrivateExistingInside(root, INDEX_RELATIVE_PATH);
    if (!(await lstat(indexPath)).isFile()) {
      throw staleIndexError("the index path exists but is not a regular file");
    }
    raw = await readFile(indexPath, "utf8");
  } catch (error) {
    if (error instanceof ResearchStewardError && error.code === "STALE_LEDGER_INDEX") {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "EISDIR") {
      throw staleIndexError("the index path is a directory");
    }
    throw error;
  }
  try {
    return LedgerIndexSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw staleIndexError(`index file is unreadable or malformed: ${errorMessage(error)}`);
  }
}

export async function readEventsWithIndex(root: string): Promise<CommittedEvent[]> {
  const index = await readStoredIndex(root);
  if (index === null) return readEvents(root);

  // The full hash-chain verification always runs; store errors about the
  // ledger itself (tampered events, broken head) surface unchanged.
  const events = await readEvents(root);

  const lastEvent = events.at(-1);
  const lastCheckpoint = index.checkpoints.at(-1);
  if (lastEvent === undefined) {
    if (lastCheckpoint !== undefined) {
      throw staleIndexError("the index has checkpoints but the ledger is empty");
    }
    return events;
  }
  if (index.project_id !== lastEvent.project_id) {
    throw staleIndexError("the index belongs to a different project");
  }
  if (
    lastCheckpoint === undefined ||
    lastCheckpoint.sequence !== lastEvent.sequence ||
    lastCheckpoint.event_id !== lastEvent.event_id ||
    lastCheckpoint.event_hash !== lastEvent.event_hash ||
    lastCheckpoint.cumulative_count !== events.length
  ) {
    throw staleIndexError("the final checkpoint does not match the ledger head");
  }
  for (const checkpoint of index.checkpoints) {
    const event = events[checkpoint.sequence - 1];
    if (
      event === undefined ||
      event.event_id !== checkpoint.event_id ||
      event.event_hash !== checkpoint.event_hash ||
      checkpoint.cumulative_count !== event.sequence
    ) {
      throw staleIndexError(`checkpoint at sequence ${checkpoint.sequence} does not match the ledger`);
    }
  }
  return events;
}
