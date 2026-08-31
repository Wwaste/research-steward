import { chmod, cp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommittedEvent } from "../src/protocol.js";
import { buildLedgerIndex, readEventsWithIndex, writeLedgerIndex } from "../src/ledger-index.js";
import {
  applyMaintenance,
  inspectMaintenance,
  planMaintenance,
  rehearseRestore,
  type MaintenanceInspection
} from "../src/maintenance.js";
import { appendEvent, freezePacket, readEvents } from "../src/store.js";
import { sha256Text } from "../src/utils.js";
import {
  eventFiles,
  expectErrorCode,
  initializedProject,
  temporaryDirectory
} from "./helpers.js";

function generation(seed: string): string {
  return sha256Text(seed).slice(0, 32);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

interface PlantedTombstones {
  tombstones: string[];
  decoys: string[];
}

/**
 * Plant real-looking retired lease directories plus decoys that a strict
 * scanner must ignore: a wrong-generation name, an uppercase generation, and
 * a plain file that only looks like a tombstone.
 */
async function plantTombstones(root: string): Promise<PlantedTombstones> {
  const research = path.join(root, ".research");
  await mkdir(path.join(research, "runs", "run-1"), { recursive: true });
  const tombstones = [
    path.join(research, `.event-lock.retired-${generation("event")}`),
    path.join(research, `.render-lock.retired-${generation("render")}`),
    path.join(research, `.resource-review-lock.retired-${generation("resource")}`),
    path.join(research, `.packet-pkt-1-lock.retired-${generation("packet")}`),
    path.join(research, "runs", "run-1", `.lease.retired-${generation("lease")}`)
  ];
  for (const tombstone of tombstones) {
    await mkdir(tombstone);
  }
  await writeFile(path.join(tombstones[0]!, "owner.json"), '{"owner_token":"a"}\n', "utf8");
  await writeFile(path.join(tombstones[4]!, "owner.json"), '{"owner_token":"b"}\n', "utf8");

  const decoys = [
    path.join(research, ".event-lock.retired-tooshort"),
    path.join(research, `.event-lock.retired-${"A".repeat(32)}`)
  ];
  for (const decoy of decoys) {
    await mkdir(decoy);
  }
  const fileDecoy = path.join(research, `.render-lock.retired-${generation("file-decoy")}`);
  // Same strict name, but a regular file: must never be counted or deleted.
  await writeFile(fileDecoy, "not a directory\n", "utf8");
  decoys.push(fileDecoy);
  return { tombstones, decoys };
}

async function projectWithPacket(): Promise<string> {
  const root = await initializedProject("Maintenance test");
  await writeFile(path.join(root, "notes.md"), "# Notes\n\nFrozen review input.\n", "utf8");
  await freezePacket(root, "pkt-1", ["notes.md"]);
  return root;
}

describe("inspectMaintenance", () => {
  it("reports a bare research directory with no protocol history", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, ".research"));
    expect(await inspectMaintenance(root)).toEqual({
      tombstones: { count: 0, oldest_age_ms: null },
      ledger: { events: 0, head_consistent: false },
      index: { present: false, stale: false },
      backups: { present: false }
    });
  });

  it("reports a freshly initialized project as consistent", async () => {
    const root = await initializedProject("Clean project");
    const inspection = await inspectMaintenance(root);
    expect(inspection.ledger).toEqual({ events: 1, head_consistent: true });
    expect(inspection.index).toEqual({ present: false, stale: false });
    expect(inspection.backups).toEqual({ present: false });
    // Every released directory lease retires into a deterministic tombstone,
    // so even a fresh project already carries its own lock generations.
    expect(inspection.tombstones.count).toBeGreaterThan(0);
    expect(inspection.tombstones.oldest_age_ms).not.toBeNull();
  });

  it("counts only strictly named tombstone directories and sees backups", async () => {
    const root = await initializedProject("Tombstone census");
    const baseline = (await inspectMaintenance(root)).tombstones.count;
    await plantTombstones(root);
    await mkdir(path.join(root, ".research", "backups"));

    const inspection = await inspectMaintenance(root);
    expect(inspection.tombstones.count).toBe(baseline + 5);
    expect(inspection.tombstones.oldest_age_ms).not.toBeNull();
    expect(inspection.tombstones.oldest_age_ms!).toBeGreaterThanOrEqual(0);
    expect(inspection.ledger).toEqual({ events: 1, head_consistent: true });
    expect(inspection.backups.present).toBe(true);
  });

  it("reports an inconsistent ledger head without throwing", async () => {
    const root = await initializedProject("Broken head");
    const headPath = path.join(root, ".research", "ledger-head.json");
    const head = JSON.parse(await readFile(headPath, "utf8")) as { event_count: number };
    head.event_count += 5;
    await writeFile(headPath, `${JSON.stringify(head, null, 2)}\n`, "utf8");

    const inspection = await inspectMaintenance(root);
    expect(inspection.ledger.events).toBe(1);
    expect(inspection.ledger.head_consistent).toBe(false);
  });

  it("treats a directory at the index path as present and stale so rebuild is reachable", async () => {
    const root = await initializedProject("Directory index");
    await mkdir(path.join(root, ".research", "cache", "ledger-index.json"), {
      recursive: true
    });
    const inspection = await inspectMaintenance(root);
    expect(inspection.index).toEqual({ present: true, stale: true });
    expect(planMaintenance(inspection).actions.map((action) => action.kind)).toContain(
      "rebuild_index"
    );
  });

  it("flags a lagging index as present and stale", async () => {
    const root = await initializedProject("Stale index");
    await writeLedgerIndex(root, await buildLedgerIndex(root));
    await appendEvent(root, {
      type: "candidate_declared",
      actor: { id: "maintenance-fixture", role: "author" },
      summary: "Event appended after the index was built."
    });

    const inspection = await inspectMaintenance(root);
    expect(inspection.index).toEqual({ present: true, stale: true });
  });
});

describe("planMaintenance", () => {
  it("is a pure function that maps findings to explicit actions", () => {
    const inspection: MaintenanceInspection = {
      tombstones: { count: 4, oldest_age_ms: 1_000 },
      ledger: { events: 10, head_consistent: true },
      index: { present: true, stale: true },
      backups: { present: false }
    };
    const plan = planMaintenance(inspection);
    expect(plan).toEqual(planMaintenance(inspection));
    expect(plan.actions).toEqual([
      { id: "delete-tombstones", kind: "delete_tombstones", requires_offline: true, targets: 4 },
      { id: "rebuild-index", kind: "rebuild_index", requires_offline: true, targets: 1 }
    ]);
  });

  it("plans an explicit no-op for a clean inspection", () => {
    const inspection: MaintenanceInspection = {
      tombstones: { count: 0, oldest_age_ms: null },
      ledger: { events: 1, head_consistent: true },
      index: { present: false, stale: false },
      backups: { present: false }
    };
    expect(planMaintenance(inspection).actions).toEqual([
      { id: "no-op", kind: "none", requires_offline: false, targets: 0 }
    ]);
  });
});

describe("applyMaintenance", () => {
  it("refuses to run without explicit offline confirmation", async () => {
    const root = await initializedProject("Offline gate");
    const { tombstones } = await plantTombstones(root);
    const plan = planMaintenance(await inspectMaintenance(root));

    await expectErrorCode(
      applyMaintenance(root, plan, { offline_confirmed: false }),
      "MAINTENANCE_REQUIRES_OFFLINE"
    );
    for (const tombstone of tombstones) {
      expect(await pathExists(tombstone)).toBe(true);
    }
  });

  it("deletes only confirmed tombstones and leaves the ledger and frozen bytes intact", async () => {
    const root = await projectWithPacket();
    const baseline = (await inspectMaintenance(root)).tombstones.count;
    const { tombstones, decoys } = await plantTombstones(root);
    // Strictly named tombstone whose contents are unexpected: second
    // confirmation must refuse to delete it.
    const suspicious = path.join(
      root,
      ".research",
      `.event-lock.retired-${generation("suspicious")}`
    );
    await mkdir(suspicious);
    await writeFile(path.join(suspicious, "data.txt"), "unexpected payload\n", "utf8");

    const eventsBefore = await readEvents(root);
    const eventFilesBefore = await eventFiles(root);

    const inspection = await inspectMaintenance(root);
    expect(inspection.tombstones.count).toBe(baseline + 6);
    const plan = planMaintenance(inspection);
    const result = await applyMaintenance(root, plan, { offline_confirmed: true });

    const deleteResult = result.actions.find((action) => action.kind === "delete_tombstones");
    expect(deleteResult).toMatchObject({ completed: baseline + 5, skipped: 1 });
    expect((await inspectMaintenance(root)).tombstones.count).toBe(1);
    for (const tombstone of tombstones) {
      expect(await pathExists(tombstone)).toBe(false);
    }
    expect(await pathExists(suspicious)).toBe(true);
    for (const decoy of decoys) {
      expect(await pathExists(decoy)).toBe(true);
    }

    expect(await readEvents(root)).toEqual(eventsBefore);
    expect(await eventFiles(root)).toEqual(eventFilesBefore);
    expect(
      await pathExists(path.join(root, ".research", "frozen", "pkt-1", "manifest.json"))
    ).toBe(true);
  });

  it("rebuilds a stale index when the plan says so", async () => {
    const root = await initializedProject("Index rebuild");
    await writeLedgerIndex(root, await buildLedgerIndex(root));
    await appendEvent(root, {
      type: "candidate_declared",
      actor: { id: "maintenance-fixture", role: "author" },
      summary: "Event that makes the index stale."
    });
    await expectErrorCode(readEventsWithIndex(root), "STALE_LEDGER_INDEX");

    const plan = planMaintenance(await inspectMaintenance(root));
    expect(plan.actions.map((action) => action.kind)).toContain("rebuild_index");
    await applyMaintenance(root, plan, { offline_confirmed: true });

    expect(await readEventsWithIndex(root)).toEqual(await readEvents(root));
    expect((await inspectMaintenance(root)).index).toEqual({ present: true, stale: false });
  });
});

describe("rehearseRestore", () => {
  it("passes for an intact backup and compares active packet IDs", async () => {
    const root = await projectWithPacket();
    const eventsBefore = await readEvents(root);
    const backupDir = path.join(await temporaryDirectory(), "backup");
    await cp(root, backupDir, { recursive: true });
    const targetDir = path.join(await temporaryDirectory(), "restored");

    const result = await rehearseRestore(root, backupDir, targetDir);
    expect(result.failure).toBeNull();
    expect(result.report?.passed).toBe(true);
    expect(result.active_packets).toEqual({
      source_ids: ["pkt-1"],
      restored_ids: ["pkt-1"],
      match: true
    });
    expect(result.passed).toBe(true);
    // The rehearsal verifies the isolated copy, never the live project.
    expect(await readEvents(root)).toEqual(eventsBefore);
  });

  it("returns a failure report for a tampered backup", async () => {
    const root = await projectWithPacket();
    const backupDir = path.join(await temporaryDirectory(), "backup");
    await cp(root, backupDir, { recursive: true });
    const name = (await eventFiles(backupDir))[0]!;
    const eventPath = path.join(backupDir, ".research", "events", name);
    const event = JSON.parse(await readFile(eventPath, "utf8")) as CommittedEvent;
    event.summary = "Tampered after backup.";
    await writeFile(eventPath, `${JSON.stringify(event, null, 2)}\n`, "utf8");

    const targetDir = path.join(await temporaryDirectory(), "restored");
    const result = await rehearseRestore(root, backupDir, targetDir);
    expect(result.passed).toBe(false);
    expect(result.failure !== null || result.report?.passed === false).toBe(true);
    expect(result.active_packets.match).toBe(false);
  });

  it("refuses an existing or non-isolated target directory", async () => {
    const root = await projectWithPacket();
    const backupDir = path.join(await temporaryDirectory(), "backup");
    await cp(root, backupDir, { recursive: true });

    const existingTarget = await temporaryDirectory();
    await expectErrorCode(
      rehearseRestore(root, backupDir, existingTarget),
      "RESTORE_TARGET_EXISTS"
    );
    await expectErrorCode(
      rehearseRestore(root, backupDir, path.join(backupDir, "restored")),
      "RESTORE_TARGET_NOT_ISOLATED"
    );
    await expectErrorCode(
      rehearseRestore(root, backupDir, path.join(root, "restored")),
      "RESTORE_TARGET_NOT_ISOLATED"
    );
  });
});

describe("applyMaintenance hardening", () => {
  it("skips a tombstone whose owner.json is not a regular file", async () => {
    const root = await initializedProject("Odd tombstone");
    const odd = path.join(root, ".research", `.event-lock.retired-${generation("odd")}`);
    // owner.json exists, but as a directory: the second confirmation must
    // refuse to treat this as a retired lease.
    await mkdir(path.join(odd, "owner.json"), { recursive: true });

    const plan = planMaintenance(await inspectMaintenance(root));
    const result = await applyMaintenance(root, plan, { offline_confirmed: true });
    const deleteResult = result.actions.find((action) => action.kind === "delete_tombstones");
    expect(deleteResult?.skipped).toBe(1);
    expect(await pathExists(odd)).toBe(true);
  });

  it("refuses a plan whose tombstone targets no longer match the current scan", async () => {
    const root = await initializedProject("Stale plan");
    const plan = planMaintenance(await inspectMaintenance(root));
    expect(plan.actions.map((action) => action.kind)).toContain("delete_tombstones");
    const late = path.join(root, ".research", `.event-lock.retired-${generation("late")}`);
    await mkdir(late);

    await expectErrorCode(
      applyMaintenance(root, plan, { offline_confirmed: true }),
      "MAINTENANCE_PLAN_STALE"
    );
    expect(await pathExists(late)).toBe(true);
    const rescan = await inspectMaintenance(root);
    expect(rescan.tombstones.count).toBe(
      plan.actions.find((action) => action.kind === "delete_tombstones")!.targets + 1
    );
  });
});

describe("rehearseRestore isolation and copy failures", () => {
  it("rejects a real-path target inside a project whose root is passed as a symlink alias", async () => {
    const base = await temporaryDirectory();
    const realRoot = path.join(base, "real-root");
    await mkdir(realRoot);
    const aliasRoot = path.join(base, "alias-root");
    await symlink(realRoot, aliasRoot);
    const backupDir = path.join(base, "backup");
    await mkdir(backupDir);

    await expectErrorCode(
      rehearseRestore(aliasRoot, backupDir, path.join(realRoot, "restored")),
      "RESTORE_TARGET_NOT_ISOLATED"
    );
  });

  it("rejects a symlink-aliased target that resolves into the real project root", async () => {
    const base = await temporaryDirectory();
    const realRoot = path.join(base, "real-root");
    await mkdir(realRoot);
    const aliasRoot = path.join(base, "alias-root");
    await symlink(realRoot, aliasRoot);
    const backupDir = path.join(base, "backup");
    await mkdir(backupDir);

    await expectErrorCode(
      rehearseRestore(realRoot, backupDir, path.join(aliasRoot, "restored")),
      "RESTORE_TARGET_NOT_ISOLATED"
    );
  });

  it("wraps a failed backup copy as RESTORE_COPY_FAILED", async () => {
    const root = await projectWithPacket();
    const base = await temporaryDirectory();
    const backupDir = path.join(base, "backup");
    await mkdir(backupDir);
    const lockedParent = path.join(base, "locked");
    await mkdir(lockedParent, { mode: 0o500 });
    try {
      await expectErrorCode(
        rehearseRestore(root, backupDir, path.join(lockedParent, "restored")),
        "RESTORE_COPY_FAILED"
      );
    } finally {
      await chmod(lockedParent, 0o700);
    }
  });
});
