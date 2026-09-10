import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyMaintenance,
  inspectMaintenance,
  planMaintenance
} from "../src/maintenance.js";
import { writeLedgerIndex, buildLedgerIndex } from "../src/ledger-index.js";
import { appendEvent, freezePacket } from "../src/store.js";
import { sha256Text, stableJson } from "../src/utils.js";
import {
  expectErrorCode,
  initializedProject,
  temporaryDirectory
} from "./helpers.js";

function generation(seed: string): string {
  return sha256Text(seed).slice(0, 32);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    try {
      await (await import("node:fs/promises")).stat(p);
      return true;
    } catch {
      return false;
    }
  }
}

describe("maintenance CR-M A-group evidence", () => {
  it("CR-M-016: apply deletes only the frozen target set", async () => {
    const root = await initializedProject("Frozen set");
    const named = path.join(root, ".research", `.event-lock.retired-${generation("named")}`);
    await mkdir(named);
    const plan = await planMaintenance(root, await inspectMaintenance(root));
    const action = plan.actions.find((a) => a.kind === "delete_tombstones")!;
    expect(action.target_paths).toEqual(
      expect.arrayContaining([`.research/.event-lock.retired-${generation("named")}`])
    );
    // Extra unplanned tombstone after plan → whole apply stale, named survives.
    const extra = path.join(root, ".research", `.event-lock.retired-${generation("extra")}`);
    await mkdir(extra);
    await expectErrorCode(
      applyMaintenance(root, plan, { offline_confirmed: true, plan_hash: plan.plan_hash }),
      "MAINTENANCE_PLAN_STALE"
    );
    const extraStillThere = await (await import("node:fs/promises"))
      .stat(extra)
      .then(() => true)
      .catch(() => false);
    expect(extraStillThere).toBe(true);
  });

  it("CR-M-016: duplicate planned paths are rejected by identitiesMatch", async () => {
    const root = await initializedProject("Dup paths");
    await mkdir(path.join(root, ".research", `.event-lock.retired-${generation("d")}`));
    const base = await planMaintenance(root, await inspectMaintenance(root));
    const deleteAction = base.actions.find((a) => a.kind === "delete_tombstones")!;
    const first = deleteAction.target_identities[0]!;
    const forged = {
      ...base,
      actions: [
        { ...deleteAction, target_identities: [first, first], targets: 2 }
      ]
    };
    const body = {
      plan_id: forged.plan_id,
      project_id: forged.project_id,
      ledger_head: forged.ledger_head,
      inspected_at: forged.inspected_at,
      actions: forged.actions
    };
    const hashed = { ...body, plan_hash: sha256Text(stableJson(body)) };
    await expectErrorCode(
      applyMaintenance(root, hashed as never, {
        offline_confirmed: true,
        plan_hash: hashed.plan_hash
      }),
      "MAINTENANCE_PLAN_STALE"
    );
  });

  it("CR-M-017: rebuild against a directory fails closed INDEX_PATH_NOT_REGULAR", async () => {
    const root = await initializedProject("Rebuild dir");
    await mkdir(path.join(root, ".research", "cache", "ledger-index.json"), {
      recursive: true
    });
    const inspection = await inspectMaintenance(root);
    const plan = await planMaintenance(root, inspection);
    expect(plan.actions.map((a) => a.kind)).toContain("quarantine_index");
    const forgedBody = {
      plan_id: plan.plan_id,
      project_id: plan.project_id,
      ledger_head: plan.ledger_head,
      inspected_at: plan.inspected_at,
      actions: [
        {
          id: "rebuild-index",
          kind: "rebuild_index",
          requires_offline: true,
          targets: 1,
          target_paths: [".research/cache/ledger-index.json"],
          target_identities: []
        }
      ]
    };
    const forged = {
      ...forgedBody,
      plan_hash: sha256Text(stableJson(forgedBody))
    };
    await expectErrorCode(
      applyMaintenance(root, forged as never, {
        offline_confirmed: true,
        plan_hash: forged.plan_hash
      }),
      "INDEX_PATH_NOT_REGULAR"
    );
  });

  it("CR-M-018: missing ledger-head keeps project_id in identity", async () => {
    const root = await initializedProject("No head");
    await rm(path.join(root, ".research", "ledger-head.json"), { force: true });
    const inspection = await inspectMaintenance(root);
    expect(inspection.project_id).not.toBeNull();
    expect(inspection.ledger_head).toBeNull();
  });

  it("CR-M-020: quarantine detail carries a shallow content digest", async () => {
    const root = await initializedProject("Quarantine digest");
    const indexPath = path.join(root, ".research", "cache", "ledger-index.json");
    await mkdir(indexPath, { recursive: true });
    await writeFile(path.join(indexPath, "junk.txt"), "x\n", "utf8");
    const plan = await planMaintenance(root, await inspectMaintenance(root));
    const action = plan.actions.find((a) => a.kind === "quarantine_index")!;
    expect(action.detail?.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(action.detail?.entry_names).toContain("junk.txt");
  });

  it("CR-M-022: swapping plan_id invalidates plan_hash", async () => {
    const root = await initializedProject("Plan id hash");
    const plan = await planMaintenance(root, await inspectMaintenance(root));
    const swapped = { ...plan, plan_id: "00000000-0000-0000-0000-000000000000" };
    await expectErrorCode(
      applyMaintenance(root, swapped, {
        offline_confirmed: true,
        plan_hash: plan.plan_hash
      }),
      "MAINTENANCE_PLAN_HASH_MISMATCH"
    );
  });

  it("CR-M-023: .research/cache as a regular file is classified, not a raw ENOTDIR", async () => {
    const root = await initializedProject("Cache as file");
    const cachePath = path.join(root, ".research", "cache");
    await rm(cachePath, { recursive: true, force: true });
    await writeFile(cachePath, "file\n", "utf8");
    const inspection = await inspectMaintenance(root);
    expect(inspection.index.kind).toBe("other");
  });

  it("CR-M-025: planMaintenance is documented as non-pure (minted plan_id)", async () => {
    const src = await readFile(
      path.join(import.meta.dirname, "..", "src", "maintenance.ts"),
      "utf8"
    );
    expect(src).toContain("randomUUID");
    expect(src).not.toMatch(/planMaintenance is a pure function/);
  });
});
