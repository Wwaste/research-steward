import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { cp, lstat, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CommittedEvent, VerificationReport } from "./protocol.js";
import { buildLedgerIndex, readEventsWithIndex, writeLedgerIndex } from "./ledger-index.js";
import {
  ensurePrivateDirectoryInside,
  resolvePrivateDestinationInside,
  resolvePrivateExistingInside
} from "./paths.js";
import { readEvents, verifyProject } from "./store.js";
import { ResearchStewardError, errorMessage, sha256Text, stableJson } from "./utils.js";

/**
 * Maintenance separates observation from mutation: inspectMaintenance is
 * read-only, planMaintenance freezes an exact target set (and may lstat the
 * index anomaly for a shallow digest), and only applyMaintenance touches the
 * filesystem — after an explicit offline confirmation bound to plan_hash.
 */

export type IndexEntryKind = "missing" | "file" | "directory" | "symlink" | "other";

export interface TombstoneTarget {
  relative_path: string;
  generation: string;
  owner_sha256: string | null;
}

export interface MaintenanceInspection {
  project_id: string | null;
  ledger_head: string | null;
  inspected_at: string;
  tombstones: {
    count: number;
    oldest_age_ms: number | null;
    targets: TombstoneTarget[];
  };
  ledger: { events: number; head_consistent: boolean };
  index: { present: boolean; stale: boolean; kind: IndexEntryKind };
  backups: { present: boolean };
}

export type MaintenanceActionKind =
  | "delete_tombstones"
  | "rebuild_index"
  | "quarantine_index"
  | "none";

export interface MaintenanceAction {
  id: string;
  kind: MaintenanceActionKind;
  requires_offline: boolean;
  targets: number;
  target_paths: string[];
  target_identities: TombstoneTarget[];
  detail?: {
    index_kind: IndexEntryKind;
    summary: string;
    /** Shallow content digest of the anomaly, recomputed at apply (CR-M-020). */
    content_sha256: string;
    entry_names: string[];
    entry_count: number;
  };
}

export interface MaintenancePlan {
  plan_id: string;
  plan_hash: string;
  project_id: string | null;
  ledger_head: string | null;
  inspected_at: string;
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

interface TombstoneRecord extends TombstoneTarget {
  mtime_ms: number;
}

const GENERATION_FROM_NAME = /retired-([a-f0-9]{32})$/;

async function tombstoneIdentity(
  absolute: string,
  relativePath: string
): Promise<TombstoneTarget | null> {
  const info = await lstat(absolute);
  if (!info.isDirectory()) return null;
  const name = path.basename(absolute);
  const generationMatch = GENERATION_FROM_NAME.exec(name);
  if (!generationMatch) return null;
  let ownerSha: string | null = null;
  try {
    const ownerBytes = await readFile(path.join(absolute, "owner.json"));
    ownerSha = sha256Text(ownerBytes.toString("utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Missing owner is representable; a non-file owner.json still keeps the
    // tombstone in the exact-target set so apply can refuse or skip it.
    if (code !== "ENOENT" && code !== "EISDIR" && code !== "EACCES") return null;
  }
  return {
    relative_path: relativePath,
    generation: generationMatch[1]!,
    owner_sha256: ownerSha
  };
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
    const relativePath = `.research/${entry.name}`;
    const absolute = path.join(researchDir, entry.name);
    const identity = await tombstoneIdentity(absolute, relativePath);
    if (!identity) continue;
    const info = await lstat(absolute);
    records.push({ ...identity, mtime_ms: info.mtimeMs });
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
      const relativePath = `.research/runs/${runEntry.name}/${entry.name}`;
      const absolute = path.join(runDir, entry.name);
      const identity = await tombstoneIdentity(absolute, relativePath);
      if (!identity) continue;
      const info = await lstat(absolute);
      records.push({ ...identity, mtime_ms: info.mtimeMs });
    }
  }
  return records;
}

async function classifyIndexPath(root: string): Promise<{
  present: boolean;
  kind: IndexEntryKind;
  absolute: string | null;
}> {
  // Resolve the parent directory through the private path policy, then lstat
  // the leaf without realpath: the leaf may be a symlink that
  // resolvePrivateExistingInside would refuse before we could classify it.
  let parent: string;
  try {
    parent = await resolvePrivateExistingInside(root, ".research/cache");
  } catch (error) {
    if (isEnoent(error)) return { present: false, kind: "missing", absolute: null };
    throw error;
  }
  const absolute = path.join(parent, "ledger-index.json");
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (isEnoent(error)) return { present: false, kind: "missing", absolute: null };
    // Parent is a regular file, so the leaf path is ENOTDIR — still a
    // non-regular index location that quarantine must be able to see (CR-M-023).
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
      return { present: true, kind: "other", absolute };
    }
    throw error;
  }
  if (info.isSymbolicLink()) return { present: true, kind: "symlink", absolute };
  if (info.isDirectory()) return { present: true, kind: "directory", absolute };
  if (info.isFile()) return { present: true, kind: "file", absolute };
  return { present: true, kind: "other", absolute };
}

async function projectIdentity(
  root: string
): Promise<{ project_id: string | null; ledger_head: string | null }> {
  // Read manifest and head independently: a missing ledger-head.json must not
  // discard a valid project_id, or cross-project plan reuse loses its gate
  // exactly on the damaged projects maintenance is for (CR-M-018).
  let projectId: string | null = null;
  let ledgerHead: string | null = null;
  try {
    const manifestPath = await resolvePrivateExistingInside(root, ".research/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { project_id?: string };
    projectId = typeof manifest.project_id === "string" ? manifest.project_id : null;
  } catch (error) {
    if (isEnoent(error)) projectId = null;
    else if (error instanceof SyntaxError) {
      throw new ResearchStewardError(
        "PROJECT_IDENTITY_UNREADABLE",
        `manifest.json is not valid JSON: ${errorMessage(error)}`
      );
    } else throw error;
  }
  try {
    const headPath = await resolvePrivateExistingInside(root, ".research/ledger-head.json");
    const head = JSON.parse(await readFile(headPath, "utf8")) as {
      last_event_hash?: string | null;
    };
    ledgerHead = typeof head.last_event_hash === "string" ? head.last_event_hash : null;
  } catch (error) {
    if (isEnoent(error)) ledgerHead = null;
    else if (error instanceof SyntaxError) {
      throw new ResearchStewardError(
        "PROJECT_IDENTITY_UNREADABLE",
        `ledger-head.json is not valid JSON: ${errorMessage(error)}`
      );
    } else throw error;
  }
  return { project_id: projectId, ledger_head: ledgerHead };
}

export async function inspectMaintenance(root: string): Promise<MaintenanceInspection> {
  const tombstones = await scanTombstones(root);
  const now = Date.now();
  const oldestAgeMs =
    tombstones.length === 0
      ? null
      : Math.max(0, ...tombstones.map((record) => now - record.mtime_ms));
  const identity = await projectIdentity(root);

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

  const indexEntry = await classifyIndexPath(root);
  let indexStale = false;
  if (indexEntry.present && indexEntry.kind === "file") {
    try {
      await readEventsWithIndex(root);
    } catch (error) {
      indexStale =
        error instanceof ResearchStewardError && error.code === "STALE_LEDGER_INDEX";
    }
  } else if (indexEntry.present) {
    // A non-regular entry at the cache path is never a valid index; quarantine
    // must stay reachable even when the private path policy rejects the leaf
    // before readEventsWithIndex can classify it.
    indexStale = true;
  }

  let backupsPresent = false;
  try {
    const backupsPath = await resolvePrivateExistingInside(root, ".research/backups");
    backupsPresent = (await lstat(backupsPath)).isDirectory();
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  return {
    project_id: identity.project_id,
    ledger_head: identity.ledger_head,
    inspected_at: new Date().toISOString(),
    tombstones: {
      count: tombstones.length,
      oldest_age_ms: oldestAgeMs,
      targets: tombstones.map(({ relative_path, generation, owner_sha256 }) => ({
        relative_path,
        generation,
        owner_sha256
      }))
    },
    ledger: { events: eventFileCount, head_consistent: headConsistent },
    index: {
      present: indexEntry.present,
      stale: indexStale,
      kind: indexEntry.kind
    },
    backups: { present: backupsPresent }
  };
}

function planBodyHash(plan: Omit<MaintenancePlan, "plan_hash">): string {
  // plan_id is inside the hashed body so a swapped id cannot ride along with a
  // valid hash (CR-M-022).
  return sha256Text(stableJson(plan));
}

/**
 * Bounded shallow digest of a non-regular index anomaly: depth-1 names only,
 * never a recursive walk (a hostile tree must not become a DoS surface).
 */
async function shallowContentDigest(
  absolute: string
): Promise<{ content_sha256: string; entry_names: string[]; entry_count: number }> {
  const info = await lstat(absolute);
  if (!info.isDirectory()) {
    const payload = `kind:${info.isSymbolicLink() ? "symlink" : "other"}`;
    return {
      content_sha256: sha256Text(payload),
      entry_names: [],
      entry_count: 0
    };
  }
  const names = (await readdir(absolute)).sort();
  const capped = names.slice(0, 32);
  return {
    content_sha256: sha256Text(stableJson({ names: capped, count: names.length })),
    entry_names: capped,
    entry_count: names.length
  };
}

export async function planMaintenance(
  root: string,
  inspection: MaintenanceInspection
): Promise<MaintenancePlan> {
  const actions: MaintenanceAction[] = [];
  if (inspection.tombstones.count > 0) {
    actions.push({
      id: "delete-tombstones",
      kind: "delete_tombstones",
      requires_offline: true,
      targets: inspection.tombstones.count,
      target_paths: inspection.tombstones.targets.map((target) => target.relative_path),
      target_identities: inspection.tombstones.targets
    });
  }
  if (inspection.index.present && inspection.index.stale) {
    if (inspection.index.kind === "file") {
      actions.push({
        id: "rebuild-index",
        kind: "rebuild_index",
        requires_offline: true,
        targets: 1,
        target_paths: [".research/cache/ledger-index.json"],
        target_identities: []
      });
    } else {
      // A non-regular entry at the index path must never be overwritten in
      // place: quarantine it aside first, then rebuild a real cache.
      const entry = await classifyIndexPath(root);
      const digest =
        entry.absolute === null
          ? { content_sha256: sha256Text("missing"), entry_names: [], entry_count: 0 }
          : await shallowContentDigest(entry.absolute);
      actions.push({
        id: "quarantine-index",
        kind: "quarantine_index",
        requires_offline: true,
        targets: 1,
        target_paths: [".research/cache/ledger-index.json"],
        target_identities: [],
        detail: {
          index_kind: inspection.index.kind,
          summary: `ledger-index.json is a ${inspection.index.kind}, not a regular file`,
          ...digest
        }
      });
    }
  }
  if (actions.length === 0) {
    actions.push({
      id: "no-op",
      kind: "none",
      requires_offline: false,
      targets: 0,
      target_paths: [],
      target_identities: []
    });
  }
  const plan_id = randomUUID();
  const body = {
    plan_id,
    project_id: inspection.project_id,
    ledger_head: inspection.ledger_head,
    inspected_at: inspection.inspected_at,
    actions
  };
  return { plan_hash: planBodyHash(body), ...body };
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

function identitiesMatch(
  planned: readonly TombstoneTarget[],
  current: readonly TombstoneTarget[]
): boolean {
  if (planned.length !== current.length) return false;
  const plannedPaths = new Set(planned.map((target) => target.relative_path));
  if (plannedPaths.size !== planned.length) return false;
  const byPath = new Map(current.map((target) => [target.relative_path, target]));
  if (byPath.size !== current.length) return false;
  for (const target of planned) {
    const found = byPath.get(target.relative_path);
    if (!found) return false;
    if (found.generation !== target.generation) return false;
    if (found.owner_sha256 !== target.owner_sha256) return false;
  }
  return true;
}

function recomputePlanHash(plan: MaintenancePlan): string {
  const { plan_hash: _ignored, ...body } = plan;
  return planBodyHash(body);
}

async function writeIndexSafely(root: string): Promise<void> {
  try {
    await writeLedgerIndex(root, await buildLedgerIndex(root));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EISDIR" || code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") {
      throw new ResearchStewardError(
        "INDEX_WRITE_RACED",
        `Writing the ledger index lost a race with a concurrent filesystem change (${code}); ` +
          "re-inspect before applying again.",
        { errno: code }
      );
    }
    throw error;
  }
}

export async function applyMaintenance(
  root: string,
  plan: MaintenancePlan,
  options: { offline_confirmed: boolean; plan_hash: string }
): Promise<MaintenanceApplyResult> {
  if (options.offline_confirmed !== true) {
    throw new ResearchStewardError(
      "MAINTENANCE_REQUIRES_OFFLINE",
      "Maintenance mutates protocol storage and may only run with offline_confirmed: true, " +
        "after every writer for this project has stopped."
    );
  }
  const recomputed = recomputePlanHash(plan);
  if (recomputed !== plan.plan_hash || options.plan_hash !== plan.plan_hash) {
    throw new ResearchStewardError(
      "MAINTENANCE_PLAN_HASH_MISMATCH",
      "plan_hash must match a recomputation of the plan body and the caller-supplied value; " +
        "re-inspect and re-plan before applying.",
      { recomputed, declared: plan.plan_hash, supplied: options.plan_hash }
    );
  }
  const identity = await projectIdentity(root);
  if (
    plan.project_id !== identity.project_id ||
    plan.ledger_head !== identity.ledger_head
  ) {
    throw new ResearchStewardError(
      "MAINTENANCE_PLAN_STALE",
      "The project identity or ledger head changed since the plan was created; " +
        "re-inspect and re-plan before applying."
    );
  }

  const results: MaintenanceActionResult[] = [];
  for (const action of plan.actions) {
    switch (action.kind) {
      case "delete_tombstones": {
        const records = await scanTombstones(root);
        const current = records.map(({ relative_path, generation, owner_sha256 }) => ({
          relative_path,
          generation,
          owner_sha256
        }));
        if (records.length !== action.targets || !identitiesMatch(action.target_identities, current)) {
          throw new ResearchStewardError(
            "MAINTENANCE_PLAN_STALE",
            `The plan names ${action.targets} tombstone target(s) but the current scan ` +
              `does not match that exact path/generation/owner set; re-inspect and re-plan before applying.`
          );
        }
        // Delete only the frozen target set, never the raw rescan (CR-M-016).
        const byPath = new Map(records.map((record) => [record.relative_path, record]));
        const frozen = action.target_identities
          .map((target) => byPath.get(target.relative_path))
          .filter((record): record is TombstoneRecord => record !== undefined);
        const { deleted, skipped } = await deleteTombstones(root, frozen);
        results.push({ id: action.id, kind: action.kind, completed: deleted, skipped });
        break;
      }
      case "rebuild_index": {
        const entry = await classifyIndexPath(root);
        if (entry.present && entry.kind !== "file") {
          throw new ResearchStewardError(
            "INDEX_PATH_NOT_REGULAR",
            `Refusing to rebuild the ledger index: the path is a ${entry.kind}. ` +
              "Use a quarantine_index action first."
          );
        }
        await writeIndexSafely(root);
        results.push({ id: action.id, kind: action.kind, completed: 1, skipped: 0 });
        break;
      }
      case "quarantine_index": {
        const entry = await classifyIndexPath(root);
        if (entry.present && entry.kind === "file") {
          throw new ResearchStewardError(
            "MAINTENANCE_PLAN_STALE",
            "The index path is now a regular file; re-inspect before quarantining."
          );
        }
        if (entry.absolute && entry.present) {
          const digest = await shallowContentDigest(entry.absolute);
          if (action.detail && digest.content_sha256 !== action.detail.content_sha256) {
            throw new ResearchStewardError(
              "MAINTENANCE_PLAN_STALE",
              "The quarantined index path content changed since the plan was created; " +
                "re-inspect and re-plan before applying.",
              { planned: action.detail.content_sha256, observed: digest.content_sha256 }
            );
          }
          await ensurePrivateDirectoryInside(root, ".research/cache");
          const quarantineRelative = `.research/cache/ledger-index.json.quarantined-${plan.plan_id}`;
          const quarantineAbsolute = await resolvePrivateDestinationInside(
            root,
            quarantineRelative
          );
          try {
            await rename(entry.absolute, quarantineAbsolute);
          } catch (error) {
            throw new ResearchStewardError(
              "INDEX_QUARANTINE_FAILED",
              `Quarantining the non-regular ledger index failed: ${errorMessage(error)}`,
              { errno: (error as NodeJS.ErrnoException).code }
            );
          }
        }
        await writeIndexSafely(root);
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
