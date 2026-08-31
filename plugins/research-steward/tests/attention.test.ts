import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAttentionDigest,
  notifyLocal,
  shouldNotify,
  wakeSummary,
  type AttentionDigest
} from "../src/attention.js";
import type { VerificationReport } from "../src/protocol.js";
import { appendEvent, freezePacket, verifyProject } from "../src/store.js";
import { sha256Text, stableJson } from "../src/utils.js";
import { eventFiles, initializedProject } from "./helpers.js";

async function verifiedProject(
  title = "Attention test"
): Promise<{ root: string; report: VerificationReport }> {
  const root = await initializedProject(title);
  await writeFile(path.join(root, "analysis.md"), "candidate result\n", "utf8");
  await freezePacket(root, "candidate", ["analysis.md"]);
  const report = await verifyProject(root);
  expect(report.passed).toBe(true);
  return { root, report };
}

async function appendBlocker(root: string, actorId: string): Promise<string> {
  const blocked = await appendEvent(root, {
    type: "blocked",
    status: "blocked",
    actor: { id: actorId, role: "reviewer" },
    summary: "Open question that blocks progress."
  });
  return blocked.event_id;
}

describe("buildAttentionDigest", () => {
  it("returns an empty digest for a freshly initialized project", async () => {
    const root = await initializedProject("Nothing pending");

    const digest = await buildAttentionDigest(root);

    expect(digest.items).toEqual([]);
    expect(digest.digest_hash).toBe(sha256Text(stableJson([])));
  });

  it("derives human review and blocker items from the project summary", async () => {
    const { root, report } = await verifiedProject();

    const pending = await buildAttentionDigest(root);
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]).toMatchObject({
      kind: "human_review",
      id: report.verification_event_id
    });
    expect(pending.items[0]!.summary).not.toBe("");
    expect(pending.digest_hash).toBe(sha256Text(stableJson(pending.items)));

    const blockerId = await appendBlocker(root, "reviewer-a");
    const withBlocker = await buildAttentionDigest(root);
    expect(withBlocker.items.map((item) => item.kind)).toContain("blocker");
    expect(withBlocker.items.find((item) => item.kind === "blocker")).toMatchObject({
      id: blockerId
    });
    expect(withBlocker.digest_hash).not.toBe(pending.digest_hash);
  });

  it("does not append any event to the ledger", async () => {
    const { root } = await verifiedProject();
    const before = await eventFiles(root);

    await buildAttentionDigest(root);

    expect(await eventFiles(root)).toEqual(before);
  });
});

describe("shouldNotify", () => {
  it("notifies once per digest content and again only when the items change", async () => {
    const { root } = await verifiedProject();
    const digest = await buildAttentionDigest(root);

    expect(shouldNotify(undefined, digest)).toBe(true);
    expect(shouldNotify(digest.digest_hash, digest)).toBe(false);

    await appendBlocker(root, "reviewer-b");
    const changed = await buildAttentionDigest(root);
    expect(shouldNotify(digest.digest_hash, changed)).toBe(true);
    expect(shouldNotify(changed.digest_hash, changed)).toBe(false);
  });
});

describe("notifyLocal", () => {
  const digest: AttentionDigest = {
    digest_hash: sha256Text(stableJson([])),
    items: [
      {
        kind: "human_review",
        id: "11111111-1111-4111-8111-111111111111",
        summary: "A verification awaits confirmation."
      }
    ]
  };

  function at(hour: number): Date {
    return new Date(2026, 7, 31, hour, 30, 0);
  }

  it("delivers through the provided notifier outside quiet hours", async () => {
    const calls: Array<{ title: string; body: string }> = [];
    const result = await notifyLocal(digest, {
      notifier: async (title, body) => {
        calls.push({ title, body });
      },
      quietHours: { start: 22, end: 6 },
      now: at(12)
    });

    expect(result).toEqual({ attempted: true, delivered: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain(digest.items[0]!.id);
  });

  it("suppresses delivery inside a quiet-hours window that crosses midnight", async () => {
    const calls: string[] = [];
    const notifier = async (title: string): Promise<void> => {
      calls.push(title);
    };
    const quietHours = { start: 22, end: 6 };

    for (const hour of [22, 23, 0, 5]) {
      const result = await notifyLocal(digest, { notifier, quietHours, now: at(hour) });
      expect(result).toEqual({ attempted: false, delivered: false, reason: "quiet-hours" });
    }
    for (const hour of [6, 12, 21]) {
      const result = await notifyLocal(digest, { notifier, quietHours, now: at(hour) });
      expect(result).toEqual({ attempted: true, delivered: true });
    }
    expect(calls).toHaveLength(3);
  });

  it("honors a same-day quiet-hours window with an exclusive end", async () => {
    const quietHours = { start: 9, end: 17 };

    expect(await notifyLocal(digest, { quietHours, now: at(9) })).toEqual({
      attempted: false,
      delivered: false,
      reason: "quiet-hours"
    });
    expect(await notifyLocal(digest, { quietHours, now: at(17) })).toEqual({
      attempted: true,
      delivered: true
    });
  });

  it("does nothing when disabled", async () => {
    let called = false;
    const result = await notifyLocal(digest, {
      enabled: false,
      notifier: async () => {
        called = true;
      }
    });

    expect(result).toEqual({ attempted: false, delivered: false, reason: "disabled" });
    expect(called).toBe(false);
  });

  it("reports a throwing notifier instead of propagating the error", async () => {
    const result = await notifyLocal(digest, {
      notifier: async () => {
        throw new Error("notification channel broke");
      }
    });

    expect(result).toEqual({
      attempted: true,
      delivered: false,
      reason: "notifier-failed"
    });
  });

  it("works with the default no-op notifier and never writes ledger events", async () => {
    const { root } = await verifiedProject();
    const built = await buildAttentionDigest(root);
    const before = await eventFiles(root);

    const delivered = await notifyLocal(built, {});
    const failed = await notifyLocal(built, {
      notifier: async () => {
        throw new Error("boom");
      }
    });

    expect(delivered).toEqual({ attempted: true, delivered: true });
    expect(failed.reason).toBe("notifier-failed");
    expect(await eventFiles(root)).toEqual(before);
  });
});

describe("wakeSummary", () => {
  it("renders one plain-text paragraph naming each attention item", async () => {
    const { root, report } = await verifiedProject();
    await appendBlocker(root, "reviewer-c");
    const digest = await buildAttentionDigest(root);

    const summary = wakeSummary(digest);

    expect(summary).not.toContain("\n");
    expect(summary).toContain(report.verification_event_id);
    for (const item of digest.items) {
      expect(summary).toContain(item.id);
    }
  });

  it("says explicitly when nothing is waiting", async () => {
    const root = await initializedProject("Quiet project");
    const digest = await buildAttentionDigest(root);

    const summary = wakeSummary(digest);

    expect(summary).not.toContain("\n");
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.toLowerCase()).toContain("nothing");
  });
});

describe("notifyLocal quiet-hours edge cases (fix round 1)", () => {
  const digest: AttentionDigest = {
    digest_hash: sha256Text(stableJson([])),
    items: [
      {
        kind: "blocker",
        id: "22222222-2222-4222-8222-222222222222",
        summary: "A blocker is waiting for resolution."
      }
    ]
  };

  function at(hour: number): Date {
    return new Date(2026, 7, 31, hour, 30, 0);
  }

  it("treats start === end as an empty quiet window and always delivers", async () => {
    const calls: string[] = [];
    const notifier = async (title: string): Promise<void> => {
      calls.push(title);
    };

    for (const hour of [0, 8, 23]) {
      const result = await notifyLocal(digest, {
        notifier,
        quietHours: { start: 8, end: 8 },
        now: at(hour)
      });
      expect(result).toEqual({ attempted: true, delivered: true });
    }
    expect(calls).toHaveLength(3);
  });

  it("normalizes out-of-range quiet hours into the 0-23 range", async () => {
    // { start: -2, end: 30 } normalizes to { start: 22, end: 6 }.
    const quietHours = { start: -2, end: 30 };

    expect(await notifyLocal(digest, { quietHours, now: at(23) })).toEqual({
      attempted: false,
      delivered: false,
      reason: "quiet-hours"
    });
    expect(await notifyLocal(digest, { quietHours, now: at(5) })).toEqual({
      attempted: false,
      delivered: false,
      reason: "quiet-hours"
    });
    expect(await notifyLocal(digest, { quietHours, now: at(12) })).toEqual({
      attempted: true,
      delivered: true
    });
  });
});
