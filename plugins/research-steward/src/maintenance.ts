import type { Dirent } from "node:fs";
import { cp, lstat, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CommittedEvent, VerificationReport } from "./protocol.js";
import { buildLedgerIndex, readEventsWithIndex, writeLedgerIndex } from "./ledger-index.js";
import { resolvePrivateExistingInside } from "./paths.js";
import { readEvents, verifyProject } from "./store.js";
import { ResearchStewardError, errorMessage, stableJson } from "./utils.js";

/**
 * Maintenance separates observation from mutation: inspectMaintenance is
 * read-only, planMaintenance is a pure function of the inspection, and only
 * applyMaintenance touches the filesystem — after an explicit offline
 * confirmation.
 */

export interface MaintenanceInspection {
  tombstones: { count: number; oldest_age_ms: number | null };
  ledger: { events: number; head_consistent: boolean };
  index: { present: boolean; stale: boolean };
  backups: { present: boolean };
}

export type MaintenanceActionKind = "delete_tombstones" | "rebuild_index" | "none";

export interface MaintenanceAction {
  id: string;
  kind: MaintenanceActionKind;
  requires_offline: boolean;
  targets: number;
}

export interface MaintenancePlan {
  actions: MaintenanceAction[];
}

export interface MaintenanceActionResult {
  id: string;
  kind: MaintenanceActionKind;
  completed: number;
  skipped: number;
}

export interface MaintenanceApplyResult {
  actions: MaintenanceActionResult[];
}

export interface RestoreRehearsalResult {
  passed: boolean;
  report: VerificationReport | null;
  failure: { code: string; message: string } | null;
  active_packets: {
    source_ids: string[];
    restored_ids: string[];
    match: boolean;
  };
}

const EVENT_FILE_NAME = /^\d{8}-[0-9a-f-]{36}\.json$/;
// Retired directory-lease tombstones as produced by directory-lease.ts: the
// protocol lock name plus ".retired-" and a 32-hex-character generation.
const PROTOCOL_TOMBSTONE_NAME =
  /^\.(?:event|render|resource-[a-z0-9][a-z0-9-]{0,63}|packet-[a-z0-9][a-z0-9-]{0,63})-lock\.retired-[a-f0-9]{32}$/;
const RUN_LEASE_TOMBSTONE_NAME = /^\.lease\.retired-[a-f0-9]{32}$/;

interface TombstoneRecord {
  relative_path: string;
  mtime_ms: number;
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function scanTombstones(root: string): Promise<TombstoneRecord[]> {
  const records: TombstoneRecord[] = [];
  let researchDir: string;
  try {
    researchDir = await resolvePrivateExistingInside(root, ".research");
  } catch (error) {
    if (isEnoent(error)) return records;
    throw error;
  }
  for (const entry of await readdir(researchDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PROTOCOL_TOMBSTONE_NAME.test(entry.name)) continue;
    const info = await lstat(path.join(researchDir, entry.name));
    records.push({ relative_path: `.research/${entry.name}`, mtime_ms: info.mtimeMs });
  }
  let runEntries: Dirent[] = [];
  try {
    runEntries = await readdir(path.join(researchDir, "runs"), { withFileTypes: true });
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return records;
  }
  for (const runEntry of runEntries) {
    if (!runEntry.isDirectory()) continue;
    const runDir = path.join(researchDir, "runs", runEntry.name);
    for (const entry of await readdir(runDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !RUN_LEASE_TOMBSTONE_NAME.test(entry.name)) continue;
      const info = await lstat(path.join(runDir, entry.name));
      records.push({
        relative_path: `.research/runs/${runEntry.name}/${entry.name}`,
        mtime_ms: info.mtimeMs
      });
    }
  }
  return records;
}

export async function inspectMaintenance(root: string): Promise<MaintenanceInspection> {
  const tombstones = await scanTombstones(root);
  const now = Date.now();
  const oldestAgeMs =
    tombstones.length === 0
      ? null
      : Math.max(0, ...tombstones.map((record) => now - record.mtime_ms));

  let eventFileCount = 0;
  try {
    const eventsDir = await resolvePrivateExistingInside(root, ".research/events");
    eventFileCount = (await readdir(eventsDir)).filter((name) =>
      EVENT_FILE_NAME.test(name)
    ).length;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  let headConsistent = false;
  try {
    await readEvents(root);
    headConsistent = true;
  } catch {
    headConsistent = false;
  }

  let indexPresent = false;
  try {
    // Any existing entry counts as present, even a non-file: readEventsWithIndex
    // reports such an entry as stale, which keeps the rebuild action reachable.
    await resolvePrivateExistingInside(root, ".research/cache/ledger-index.json");
    indexPresent = true;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  let indexStale = false;
  if (indexPresent) {
    try {
      await readEventsWithIndex(root);
    } catch (error) {
      indexStale =
        error instanceof ResearchStewardError && error.code === "STALE_LEDGER_INDEX";
    }
  }

  let backupsPresent = false;
  try {
    const backupsPath = await resolvePrivateExistingInside(root, ".research/backups");
    backupsPresent = (await lstat(backupsPath)).isDirectory();
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  return {
    tombstones: { count: tombstones.length, oldest_age_ms: oldestAgeMs },
    ledger: { events: eventFileCount, head_consistent: headConsistent },
    index: { present: indexPresent, stale: indexStale },
    backups: { present: backupsPresent }
  };
}

export function planMaintenance(inspection: MaintenanceInspection): MaintenancePlan {
  const actions: MaintenanceAction[] = [];
  if (inspection.tombstones.count > 0) {
    actions.push({
      id: "delete-tombstones",
      kind: "delete_tombstones",
      requires_offline: true,
      targets: inspection.tombstones.count
    });
  }
  if (inspection.index.present && inspection.index.stale) {
    actions.push({
      id: "rebuild-index",
      kind: "rebuild_index",
      requires_offline: true,
      targets: 1
    });
  }
  if (actions.length === 0) {
    actions.push({ id: "no-op", kind: "none", requires_offline: false, targets: 0 });
  }
  return { actions };
}

async function deleteTombstones(
  root: string,
  records: readonly TombstoneRecord[]
): Promise<{ deleted: number; skipped: number }> {
  let deleted = 0;
  let skipped = 0;
  for (const record of records) {
    const segments = record.relative_path.split("/");
    const name = segments.at(-1) ?? "";
    // Second confirmation before any deletion: the name must match the strict
    // tombstone grammar again, the path must never enter events, frozen, or
    // packages, and the directory may hold nothing but the lease owner file.
    if (!PROTOCOL_TOMBSTONE_NAME.test(name) && !RUN_LEASE_TOMBSTONE_NAME.test(name)) {
      skipped += 1;
      continue;
    }
    if (segments.some((segment) => ["events", "frozen", "packages"].includes(segment))) {
      skipped += 1;
      continue;
    }
    let absolute: string;
    try {
      absolute = await resolvePrivateExistingInside(root, record.relative_path);
    } catch {
      skipped += 1;
      continue;
    }
    if (!(await lstat(absolute)).isDirectory()) {
      skipped += 1;
      continue;
    }
    const contents = await readdir(absolute, { withFileTypes: true });
    const confirmed =
      contents.length === 0 ||
      (contents.length === 1 &&
        contents[0]!.name === "owner.json" &&
        contents[0]!.isFile());
    if (!confirmed) {
      skipped += 1;
      continue;
    }
    await rm(absolute, { recursive: true, force: true });
    deleted += 1;
  }
  return { deleted, skipped };
}

export async function applyMaintenance(
  root: string,
  plan: MaintenancePlan,
  options: { offline_confirmed: boolean }
): Promise<MaintenanceApplyResult> {
  if (options.offline_confirmed !== true) {
    throw new ResearchStewardError(
      "MAINTENANCE_REQUIRES_OFFLINE",
      "Maintenance mutates protocol storage and may only run with offline_confirmed: true, " +
        "after every writer for this project has stopped."
    );
  }
  const results: MaintenanceActionResult[] = [];
  for (const action of plan.actions) {
    switch (action.kind) {
      case "delete_tombstones": {
        const records = await scanTombstones(root);
        if (records.length !== action.targets) {
          throw new ResearchStewardError(
            "MAINTENANCE_PLAN_STALE",
            `The plan names ${action.targets} tombstone target(s) but the current scan ` +
              `found ${records.length}; re-inspect and re-plan before applying.`
          );
        }
        const { deleted, skipped } = await deleteTombstones(root, records);
        results.push({ id: action.id, kind: action.kind, completed: deleted, skipped });
        break;
      }
      case "rebuild_index": {
        await writeLedgerIndex(root, await buildLedgerIndex(root));
        results.push({ id: action.id, kind: action.kind, completed: 1, skipped: 0 });
        break;
      }
      case "none": {
        results.push({ id: action.id, kind: action.kind, completed: 0, skipped: 0 });
        break;
      }
      default: {
        throw new ResearchStewardError(
          "INVALID_MAINTENANCE_ACTION",
          `Refusing to apply an unknown maintenance action kind: ${String(
            (action as { kind: unknown }).kind
          )}`
        );
      }
    }
  }
  return { actions: results };
}

function activePacketIds(events: readonly CommittedEvent[]): string[] {
  const packetIds: string[] = [];
  const superseded = new Set<string>();
  for (const event of events) {
    if (event.type !== "packet_frozen") continue;
    const packetId = event.metadata["packet_id"];
    if (typeof packetId === "string") packetIds.push(packetId);
    const supersedes = event.metadata["supersedes"];
    if (!Array.isArray(supersedes)) continue;
    for (const target of supersedes) {
      if (typeof target === "string") superseded.add(target);
    }
  }
  return packetIds.filter((packetId) => !superseded.has(packetId)).sort();
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/**
 * Canonicalize a path that is allowed not to exist yet: realpath its deepest
 * existing ancestor and re-append the missing tail. Plain string comparison
 * would miss aliases such as macOS /var -> /private/var in either direction.
 */
async function canonicalizeMissingPath(candidate: string): Promise<string> {
  const pending: string[] = [];
  let current = candidate;
  for (;;) {
    try {
      const real = await realpath(current);
      return pending.length === 0 ? real : path.join(real, ...pending);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      pending.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Restore rehearsal: copy a caller-provided backup of the project into an
 * isolated target directory, run the deterministic verifyProject there, and
 * compare the active packet IDs against the live project. The live project is
 * never written to.
 */
export async function rehearseRestore(
  root: string,
  backupDir: string,
  targetDir: string
): Promise<RestoreRehearsalResult> {
  // The live project and the backup must exist, so compare real paths; the
  // target may not exist yet, so canonicalize via its deepest existing
  // ancestor. This closes /var -> /private/var style aliasing in both
  // directions.
  const canonicalRoot = await realpath(path.resolve(root));
  let canonicalBackup: string;
  try {
    canonicalBackup = await realpath(path.resolve(backupDir));
  } catch (error) {
    if (!isEnoent(error)) throw error;
    throw new ResearchStewardError(
      "RESTORE_BACKUP_MISSING",
      "The backup to rehearse must be an existing directory."
    );
  }
  if (!(await stat(canonicalBackup)).isDirectory()) {
    throw new ResearchStewardError(
      "RESTORE_BACKUP_MISSING",
      "The backup to rehearse must be an existing directory."
    );
  }
  const canonicalTarget = await canonicalizeMissingPath(path.resolve(targetDir));
  if (
    isInside(canonicalRoot, canonicalTarget) ||
    isInside(canonicalBackup, canonicalTarget)
  ) {
    throw new ResearchStewardError(
      "RESTORE_TARGET_NOT_ISOLATED",
      "The rehearsal target must live outside both the live project and the backup."
    );
  }
  try {
    await lstat(canonicalTarget);
    throw new ResearchStewardError(
      "RESTORE_TARGET_EXISTS",
      "The rehearsal target directory must not exist yet."
    );
  } catch (error) {
    if (error instanceof ResearchStewardError) throw error;
    if (!isEnoent(error)) throw error;
  }

  try {
    await cp(canonicalBackup, canonicalTarget, { recursive: true });
  } catch (error) {
    throw new ResearchStewardError(
      "RESTORE_COPY_FAILED",
      `Copying the backup into the rehearsal target failed: ${errorMessage(error)}`
    );
  }

  const sourceIds = activePacketIds(await readEvents(canonicalRoot));
  let restoredIds: string[] = [];
  let restoredReadable = false;
  try {
    restoredIds = activePacketIds(await readEvents(canonicalTarget));
    restoredReadable = true;
  } catch {
    restoredReadable = false;
  }

  let report: VerificationReport | null = null;
  let failure: RestoreRehearsalResult["failure"] = null;
  try {
    report = await verifyProject(canonicalTarget);
  } catch (error) {
    failure = {
      code: error instanceof ResearchStewardError ? error.code : "RESTORE_VERIFY_FAILED",
      message: errorMessage(error)
    };
  }

  const match = restoredReadable && stableJson(restoredIds) === stableJson(sourceIds);
  return {
    passed: failure === null && report?.passed === true && match,
    report,
    failure,
    active_packets: {
      source_ids: sourceIds,
      restored_ids: restoredIds,
      match
    }
  };
}
