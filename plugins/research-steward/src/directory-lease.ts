import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import {
  resolvePrivateDestinationInside,
  resolvePrivateExistingInside
} from "./paths.js";
import {
  ResearchStewardError,
  sha256Text,
  writeImmutableFile
} from "./utils.js";

export interface DirectoryLease {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

interface DirectoryLeaseOptions {
  root: string;
  relative_path: string;
  stale_ms: number;
  heartbeat_ms: number;
  attempts: number;
  wait_ms: number;
  active_error: () => ResearchStewardError;
  exhausted_error: () => ResearchStewardError;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRenameConflict(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY"].includes(
    (error as NodeJS.ErrnoException).code ?? ""
  );
}

export async function acquireDirectoryLease(
  options: DirectoryLeaseOptions
): Promise<DirectoryLease> {
  const leasePath = await resolvePrivateDestinationInside(
    options.root,
    options.relative_path
  );
  const ownerToken = randomUUID();
  const candidateRelative = `${options.relative_path}.candidate-${ownerToken}`;
  const candidatePath = await resolvePrivateDestinationInside(
    options.root,
    candidateRelative
  );
  await mkdir(candidatePath, { mode: 0o700 });
  await writeImmutableFile(
    path.join(candidatePath, "owner.json"),
    `${JSON.stringify({
      owner_token: ownerToken,
      pid: process.pid,
      acquired_at: new Date().toISOString()
    })}\n`
  );

  let acquired = false;
  try {
    for (let attempt = 0; attempt < options.attempts; attempt += 1) {
      try {
        await rename(candidatePath, leasePath);
        acquired = true;
        break;
      } catch (error) {
        if (!isRenameConflict(error)) throw error;
      }

      try {
        const existing = await resolvePrivateExistingInside(
          options.root,
          options.relative_path
        );
        const before = await stat(existing);
        if (!before.isDirectory()) {
          throw new ResearchStewardError(
            "INVALID_DIRECTORY_LEASE",
            "Protocol lease is not a directory."
          );
        }
        const ownerPath = await resolvePrivateExistingInside(
          options.root,
          `${options.relative_path}/owner.json`
        );
        const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
          owner_token?: unknown;
        };
        const after = await stat(existing);
        if (before.dev !== after.dev || before.ino !== after.ino) continue;
        if (typeof owner.owner_token !== "string" || owner.owner_token.length === 0) {
          throw new ResearchStewardError(
            "INVALID_DIRECTORY_LEASE",
            "Protocol lease owner is invalid."
          );
        }
        if (Date.now() - after.mtimeMs <= options.stale_ms) {
          if (options.wait_ms === 0) throw options.active_error();
          await sleep(options.wait_ms);
          continue;
        }

        const generation = sha256Text(owner.owner_token).slice(0, 32);
        const retiredPath = await resolvePrivateDestinationInside(
          options.root,
          `${options.relative_path}.retired-${generation}`
        );
        try {
          await rename(existing, retiredPath);
        } catch (reclaimError) {
          const code = (reclaimError as NodeJS.ErrnoException).code ?? "";
          if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(code)) continue;
          throw reclaimError;
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw inspectionError;
      }
    }
  } finally {
    if (!acquired) {
      await rm(candidatePath, { recursive: true, force: true });
    }
  }

  if (!acquired) throw options.exhausted_error();

  const generation = sha256Text(ownerToken).slice(0, 32);
  const retiredPath = await resolvePrivateDestinationInside(
    options.root,
    `${options.relative_path}.retired-${generation}`
  );
  let lost = false;

  const stillOwned = async (): Promise<boolean> => {
    if (lost) return false;
    try {
      const checkedOwnerPath = await resolvePrivateExistingInside(
        options.root,
        `${options.relative_path}/owner.json`
      );
      const owner = JSON.parse(await readFile(checkedOwnerPath, "utf8")) as {
        owner_token?: unknown;
      };
      if (owner.owner_token !== ownerToken) {
        lost = true;
        return false;
      }
      return true;
    } catch {
      lost = true;
      return false;
    }
  };

  const assertOwned = async (): Promise<void> => {
    if (!(await stillOwned())) {
      throw new ResearchStewardError(
        "LOCK_LOST",
        "Protocol lease ownership was lost before the operation committed."
      );
    }
  };

  const heartbeat = setInterval(() => {
    void (async () => {
      if (!(await stillOwned())) return;
      try {
        const now = new Date();
        await utimes(leasePath, now, now);
      } catch {
        lost = true;
      }
    })();
  }, options.heartbeat_ms);
  heartbeat.unref();

  return {
    assertOwned,
    async release(): Promise<void> {
      clearInterval(heartbeat);
      if (!(await stillOwned())) {
        lost = true;
        return;
      }
      try {
        // Retire this exact generation atomically. The deterministic tombstone
        // is deliberately retained: if a successor has already reclaimed this
        // generation, a delayed predecessor cannot rename the successor over it.
        await rename(leasePath, retiredPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(code)) throw error;
      }
      lost = true;
    }
  };
}
