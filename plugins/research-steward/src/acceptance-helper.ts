import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { isMap, isScalar, parseDocument, type Document, type YAMLMap, isSeq } from "yaml";
import { resolveExistingInside } from "./paths.js";
import { readEvents, unresolvedBlockedEvents } from "./store.js";
import type { CommittedEvent } from "./protocol.js";
import { ResearchStewardError, atomicWriteFile, errorMessage } from "./utils.js";

/**
 * Locks older than this are treated as crash residue. 30s covers a full
 * ledger scan on a medium project; operations longer than this must rely on
 * the live heartbeat or re-acquire (we do not extend the lock automatically).
 */
const ACCEPTANCE_LOCK_STALE_MS = 30_000;
const ACCEPTANCE_LOCK_ATTEMPTS = 3;

export interface PrepareAcceptanceOptions {
  approvalId?: string;
}

export interface PrepareAcceptanceResult {
  approval_id: string;
  verification_event_id: string;
  verification_event_hash: string;
  changed: boolean;
}

interface SelectedApproval {
  node: YAMLMap;
  index: number;
  id: string;
}

function invalidDocument(reason: string): ResearchStewardError {
  return new ResearchStewardError(
    "INVALID_ACCEPTANCE_DOCUMENT",
    `ACCEPTANCE.yaml cannot be prepared: ${reason}`
  );
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readLockToken(lockPath: string): Promise<string | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}

/**
 * Exclusive O_EXCL lock covering the whole read-check-write of ACCEPTANCE.yaml.
 * The lock file carries a random token so release only deletes our lock and
 * stale reclaim only deletes a lock that is still the same stale one (CR-M-033).
 */
async function acquireAcceptanceLock(
  acceptancePath: string
): Promise<{ release: () => Promise<void> }> {
  const lockPath = `${acceptancePath}.lock`;
  for (let attempt = 0; attempt < ACCEPTANCE_LOCK_ATTEMPTS; attempt += 1) {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({
            token,
            pid: process.pid,
            at: new Date().toISOString()
          })}\n`
        );
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          const current = await readLockToken(lockPath);
          if (current === token) {
            await rm(lockPath, { force: true });
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ResearchStewardError(
          "ACCEPTANCE_LOCK_FAILED",
          `Could not create the acceptance lock: ${errorMessage(error)}`
        );
      }
      let stale = false;
      try {
        const info = await lstat(lockPath);
        stale = Date.now() - info.mtimeMs > ACCEPTANCE_LOCK_STALE_MS;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
        continue; // vanished; retry create
      }
      if (stale) {
        // Reclaim: rename aside, confirm it is still that stale lock, then drop.
        const quarantine = `${lockPath}.stale-${randomUUID()}`;
        try {
          await rename(lockPath, quarantine);
          const stillOurs = (await lstat(quarantine)).mtimeMs;
          if (Date.now() - stillOurs > ACCEPTANCE_LOCK_STALE_MS) {
            await rm(quarantine, { force: true });
          } else {
            // Someone recreated quickly; put ours back if lock path is free.
            await rename(quarantine, lockPath).catch(() => undefined);
          }
        } catch {
          // Lost the reclaim race; loop and try create again.
        }
        continue;
      }
      throw new ResearchStewardError(
        "ACCEPTANCE_LOCKED",
        "Another prepareAcceptance is already reading or writing ACCEPTANCE.yaml. " +
          "Wait for it to finish, or remove a stale .lock file after confirming no writer is live."
      );
    }
  }
  throw new ResearchStewardError(
    "ACCEPTANCE_LOCKED",
    `Could not acquire the acceptance lock after ${ACCEPTANCE_LOCK_ATTEMPTS} attempts.`
  );
}

function approvalIdOf(approval: YAMLMap): string {
  const value = approval.get("id");
  return typeof value === "string" && value.trim() !== "" ? value : "unnamed";
}

function selectApproval(
  approvals: readonly YAMLMap[],
  requestedId: string | undefined
): SelectedApproval {
  if (requestedId !== undefined) {
    const matches = approvals
      .map((node, index) => ({ node, index, id: approvalIdOf(node) }))
      .filter((candidate) => candidate.id === requestedId);
    if (matches.length === 0) {
      throw new ResearchStewardError(
        "APPROVAL_NOT_FOUND",
        `ACCEPTANCE.yaml has no human approval with id "${requestedId}".`
      );
    }
    if (matches.length > 1) {
      throw invalidDocument(`several human approvals share the id "${requestedId}"`);
    }
    return matches[0]!;
  }
  const required = approvals
    .map((node, index) => ({ node, index, id: approvalIdOf(node) }))
    .filter((candidate) => candidate.node.get("required") !== false);
  if (required.length === 0) {
    throw new ResearchStewardError(
      "NO_REQUIRED_APPROVAL",
      "At least one named human approval is required for scientific acceptance."
    );
  }
  if (required.length > 1) {
    throw new ResearchStewardError(
      "APPROVAL_ID_REQUIRED",
      "Several approvals are required; name the one to prepare with approvalId."
    );
  }
  return required[0]!;
}

function latestPassingVerification(
  events: readonly CommittedEvent[]
): CommittedEvent | undefined {
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "verification" &&
        event.status === "complete" &&
        event.metadata["passed"] === true
    );
}

// Mirrors the VERIFICATION_NOT_CURRENT semantics of recordAcceptance in
// store.ts: any event after the verification invalidates it, except a
// provisional review that depends on that same verification.
function eventsInvalidatingVerification(
  events: readonly CommittedEvent[],
  verification: CommittedEvent
): CommittedEvent[] {
  return events.filter(
    (event) =>
      event.sequence > verification.sequence &&
      !(
        event.type === "provisional_review" &&
        event.depends_on.includes(verification.event_id)
      )
  );
}

function readAcceptsValue(approval: YAMLMap, key: string): string | undefined {
  const accepts = approval.get("accepts");
  if (!isMap(accepts)) return undefined;
  const value = accepts.get(key);
  return typeof value === "string" ? value : undefined;
}

function writeAcceptsValue(
  doc: Document,
  approval: SelectedApproval,
  key: string,
  value: string
): void {
  const accepts = approval.node.get("accepts");
  if (isMap(accepts)) {
    const existing = accepts.get(key, true);
    if (isScalar(existing)) {
      // Mutate the parsed scalar in place so its quoting style survives.
      existing.value = value;
      return;
    }
  }
  doc.setIn(["human_approvals", approval.index, "accepts", key], value);
}

export async function prepareAcceptance(
  root: string,
  options: PrepareAcceptanceOptions = {}
): Promise<PrepareAcceptanceResult> {
  const acceptancePath = await resolveExistingInside(root, "ACCEPTANCE.yaml");
  const lock = await acquireAcceptanceLock(acceptancePath);
  try {
    return await prepareAcceptanceLocked(root, acceptancePath, options);
  } finally {
    await lock.release();
  }
}

async function prepareAcceptanceLocked(
  root: string,
  acceptancePath: string,
  options: PrepareAcceptanceOptions
): Promise<PrepareAcceptanceResult> {
  const originalBytes = await readFile(acceptancePath);
  const originalHash = sha256Bytes(originalBytes);
  const originalText = originalBytes.toString("utf8");
  const doc = parseDocument(originalText);
  if (doc.errors.length > 0) {
    throw invalidDocument(doc.errors[0]!.message);
  }
  if (doc.get("version") !== 1) {
    throw invalidDocument("the document must declare version 1");
  }
  const approvalsNode = doc.get("human_approvals");
  if (!isSeq(approvalsNode) || !approvalsNode.items.every((item) => isMap(item))) {
    throw invalidDocument("human_approvals must be a list of approval entries");
  }
  const approval = selectApproval(approvalsNode.items as YAMLMap[], options.approvalId);

  // The ledger checks below run in the same order as recordAcceptance in
  // store.ts: verification, frozen packet, blockers, then currency.
  const events = await readEvents(root);
  const verification = latestPassingVerification(events);
  if (!verification) {
    throw new ResearchStewardError(
      "VERIFICATION_REQUIRED",
      "Preparing acceptance requires a passing deterministic verification event."
    );
  }
  const packetEvents = events.filter(
    (event) => event.type === "packet_frozen" && event.sequence < verification.sequence
  );
  if (packetEvents.length === 0) {
    throw new ResearchStewardError(
      "FROZEN_PACKET_REQUIRED",
      "Scientific acceptance requires at least one frozen packet verified in this project."
    );
  }
  if (unresolvedBlockedEvents(events).length > 0) {
    throw new ResearchStewardError(
      "UNRESOLVED_BLOCKER",
      "Every blocker must be explicitly resolved and the project re-verified before preparing acceptance."
    );
  }
  if (eventsInvalidatingVerification(events, verification).length > 0) {
    throw new ResearchStewardError(
      "VERIFICATION_NOT_CURRENT",
      "The latest passing verification is no longer current; run verify again before preparing acceptance."
    );
  }

  const result: PrepareAcceptanceResult = {
    approval_id: approval.id,
    verification_event_id: verification.event_id,
    verification_event_hash: verification.event_hash,
    changed: false
  };
  if (
    readAcceptsValue(approval.node, "verification_event_id") === verification.event_id &&
    readAcceptsValue(approval.node, "verification_event_hash") === verification.event_hash
  ) {
    return result;
  }
  writeAcceptsValue(doc, approval, "verification_event_id", verification.event_id);
  writeAcceptsValue(doc, approval, "verification_event_hash", verification.event_hash);

  // Defense in depth under the exclusive lock: still CAS the raw bytes in
  // case a writer ignored the lock. The lock is the primary mutual exclusion;
  // this closes the residual rename window for cooperative writers and any
  // human editor that saves between our re-read and rename.
  let observedHash: string;
  try {
    observedHash = sha256Bytes(await readFile(acceptancePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ResearchStewardError(
        "ACCEPTANCE_DOCUMENT_CHANGED",
        "ACCEPTANCE.yaml disappeared while acceptance was being prepared; nothing was written.",
        { phase: "prepare", expected_sha256: originalHash, observed_sha256: null }
      );
    }
    throw error;
  }
  if (observedHash !== originalHash) {
    throw new ResearchStewardError(
      "ACCEPTANCE_DOCUMENT_CHANGED",
      "ACCEPTANCE.yaml changed while acceptance was being prepared; nothing was written. " +
        "Re-read the document and prepare again.",
      { phase: "prepare", expected_sha256: originalHash, observed_sha256: observedHash }
    );
  }
  await atomicWriteFile(acceptancePath, doc.toString());
  return { ...result, changed: true };
}
