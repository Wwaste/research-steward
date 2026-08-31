import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { packageHandoff } from "../src/package.js";
import {
  appendEvent,
  freezePacket,
  readEvents,
  recordAcceptance,
  verifyProject
} from "../src/store.js";
import {
  acceptedProjectWithFiles,
  expectErrorCode,
  initializedProject
} from "./helpers.js";

describe("handoff package publication", () => {
  it("publishes one clean-room verified archive and records copied-byte metadata", async () => {
    const root = await acceptedProjectWithFiles(
      { "result.txt": "auditable result\n" },
      "Package publication"
    );

    const result = await packageHandoff(root, "result-v1", ["result.txt", "result.txt"]);

    expect(result.clean_room_verified).toBe(true);
    expect(result.files).toEqual([
      expect.objectContaining({
        path: "result.txt",
        size: Buffer.byteLength("auditable result\n"),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    ]);
    await expect(stat(path.join(root, result.archive_path))).resolves.toMatchObject({
      size: expect.any(Number)
    });
    expect(await readFile(path.join(root, "HANDOFF_MANIFEST.yaml"), "utf8")).toContain(
      result.archive_sha256
    );
    const events = await readEvents(root);
    const packet = events.find((event) => event.type === "packet_frozen");
    const verification = events.find((event) => event.type === "verification");
    const acceptance = events.find((event) => event.type === "acceptance");
    const packaged = events.find((event) => event.type === "package_created");
    expect(packaged).toMatchObject({
      input_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      depends_on: [acceptance?.event_id],
      metadata: {
        packet_id: "accepted-inputs",
        acceptance_event_id: acceptance?.event_id,
        clean_room_verified: true
      }
    });
    expect(verification?.depends_on).toContain(packet?.event_id);
    expect(acceptance).toMatchObject({
      input_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      metadata: {
        acceptance_document_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        approval_snapshot_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    });
    expect(acceptance?.input_hash).toBe(acceptance?.metadata["acceptance_document_sha256"]);
  });

  it("lets exactly one concurrent packager claim an ID without deleting the winner", async () => {
    const root = await acceptedProjectWithFiles(
      { "result.txt": "stable bytes\n" },
      "Concurrent package publication"
    );

    const outcomes = await Promise.allSettled([
      packageHandoff(root, "concurrent-v1", ["result.txt"]),
      packageHandoff(root, "concurrent-v1", ["result.txt"])
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof packageHandoff>>> =>
        outcome.status === "fulfilled"
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "PACKAGE_EXISTS" });
    const winner = fulfilled[0]!.value;
    await expect(stat(path.join(root, winner.archive_path))).resolves.toMatchObject({
      size: expect.any(Number)
    });
    expect(
      (await readEvents(root)).filter((event) => event.type === "package_created")
    ).toHaveLength(1);
    await expectErrorCode(
      packageHandoff(root, "concurrent-v1", ["result.txt"]),
      "PACKAGE_EXISTS"
    );
  });

  it("refuses likely credential files before publishing an archive", async () => {
    const root = await initializedProject("Sensitive package input");
    await writeFile(path.join(root, ".env.local"), "never package me\n", "utf8");

    await expectErrorCode(
      packageHandoff(root, "sensitive-v1", [".env.local"]),
      "SENSITIVE_FILE"
    );
    await expect(stat(path.join(root, ".research", "packages", "sensitive-v1.tar.gz"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects packaging before named acceptance and after accepted source bytes change", async () => {
    const draftRoot = await initializedProject("Unaccepted package");
    await writeFile(path.join(draftRoot, "result.txt"), "draft bytes\n", "utf8");
    await expectErrorCode(
      packageHandoff(draftRoot, "draft-v1", ["result.txt"]),
      "ACCEPTANCE_REQUIRED"
    );

    const changedRoot = await acceptedProjectWithFiles({ "result.txt": "accepted bytes\n" });
    await writeFile(path.join(changedRoot, "result.txt"), "mutated bytes\n", "utf8");
    await expectErrorCode(
      packageHandoff(changedRoot, "changed-v1", ["result.txt"]),
      "ACCEPTED_SOURCE_CHANGED"
    );
  });

  it("rejects packaging when governance events change after acceptance", async () => {
    const root = await acceptedProjectWithFiles({ "result.txt": "accepted bytes\n" });
    await appendEvent(root, {
      type: "agent_contribution",
      actor: { id: "late-reviewer", role: "late reviewer" },
      summary: "A post-acceptance review changed the governed state."
    });
    await expectErrorCode(
      packageHandoff(root, "stale-acceptance", ["result.txt"]),
      "ACCEPTANCE_NOT_CURRENT"
    );
  });

  it("rejects packaging if the exact accepted approval document changes", async () => {
    const root = await acceptedProjectWithFiles({ "result.txt": "accepted bytes\n" });
    await writeFile(
      path.join(root, "ACCEPTANCE.yaml"),
      `version: 1\ncommands: []\nhuman_approvals:\n  - id: scientific-acceptance\n    required: true\n    status: approved\n    authority: test-authority\n    note: This note changed after acceptance.\n`,
      "utf8"
    );

    await expectErrorCode(
      packageHandoff(root, "changed-approval-v1", ["result.txt"]),
      "ACCEPTANCE_DOCUMENT_CHANGED"
    );
  });

  it("P1-2 packages only the active explicitly superseding packet", async () => {
    const root = await initializedProject("Revision package provenance");
    await writeFile(path.join(root, "a.md"), "a v1\n", "utf8");
    await freezePacket(root, "candidate-v1", ["a.md"]);
    await writeFile(path.join(root, "a.md"), "a v2\n", "utf8");
    await writeFile(path.join(root, "b.md"), "new reviewed file\n", "utf8");
    await freezePacket(
      root,
      "candidate-v2",
      ["a.md", "b.md"],
      ["candidate-v1"]
    );
    const verification = await verifyProject(root);
    expect(verification.passed).toBe(true);
    await writeFile(
      path.join(root, "ACCEPTANCE.yaml"),
      `version: 1\ncommands: []\nhuman_approvals:\n  - id: scientific-acceptance\n    required: true\n    status: approved\n    authority: test-authority\n    accepts:\n      verification_event_id: ${verification.verification_event_id}\n      verification_event_hash: ${verification.verification_event_hash}\n`,
      "utf8"
    );
    await recordAcceptance(root, "test-authority", "Accepted the active revision.");

    await expectErrorCode(
      packageHandoff(root, "old-revision", ["a.md"]),
      "ACCEPTED_PACKET_NOT_FOUND"
    );
    await packageHandoff(root, "current-revision", ["a.md", "b.md"]);
    expect(
      (await readEvents(root)).find(
        (event) =>
          event.type === "package_created" &&
          event.metadata["package_id"] === "current-revision"
      )?.metadata["packet_id"]
    ).toBe("candidate-v2");
  });

  it("recovers metadata exactly once when publication succeeds before finalization", async () => {
    const root = await acceptedProjectWithFiles({ "result.txt": "recoverable bytes\n" });
    const canonicalManifest = path.join(root, "HANDOFF_MANIFEST.yaml");
    const originalManifest = await readFile(canonicalManifest, "utf8");
    await rm(canonicalManifest);
    await mkdir(canonicalManifest);

    await expectErrorCode(
      packageHandoff(root, "recover-v1", ["result.txt"]),
      "PACKAGE_PUBLISHED_METADATA_FAILED"
    );
    await expect(stat(path.join(root, ".research/packages/recover-v1.tar.gz"))).resolves.toBeTruthy();
    await expect(stat(path.join(root, ".research/packages/recover-v1.commit.json"))).resolves.toBeTruthy();
    expect((await readEvents(root)).filter((event) => event.type === "package_created")).toHaveLength(0);

    await rm(canonicalManifest, { recursive: true });
    await writeFile(canonicalManifest, originalManifest, "utf8");
    const recovered = await packageHandoff(root, "recover-v1", ["result.txt"]);
    expect(recovered.clean_room_verified).toBe(true);
    expect((await readEvents(root)).filter((event) => event.type === "package_created")).toHaveLength(1);
    await expectErrorCode(
      packageHandoff(root, "recover-v1", ["result.txt"]),
      "PACKAGE_EXISTS"
    );
  });

  it("serializes different package IDs and leaves the root manifest on the last committed package", async () => {
    const root = await acceptedProjectWithFiles({ "result.txt": "shared accepted bytes\n" });
    const outcomes = await Promise.all([
      packageHandoff(root, "parallel-a", ["result.txt"]),
      packageHandoff(root, "parallel-b", ["result.txt"])
    ]);
    expect(outcomes).toHaveLength(2);
    const packageEvents = (await readEvents(root)).filter(
      (event) => event.type === "package_created"
    );
    expect(packageEvents).toHaveLength(2);
    const rootManifest = parseYaml(
      await readFile(path.join(root, "HANDOFF_MANIFEST.yaml"), "utf8")
    ) as { package_id?: string };
    expect(rootManifest.package_id).toBe(packageEvents.at(-1)?.metadata["package_id"]);
  });
});
