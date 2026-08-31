import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect } from "vitest";
import type { CommittedEvent } from "../src/protocol.js";
import {
  freezePacket,
  initializeProject,
  readEvents,
  recordAcceptance,
  verifyProject
} from "../src/store.js";

const disposableRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...disposableRoots].map((root) => rm(root, { recursive: true, force: true }))
  );
  disposableRoots.clear();
});

export async function temporaryDirectory(prefix = "research-steward-test-"): Promise<string> {
  // macOS exposes /var as a symlink to /private/var. Production requests pass
  // through RootPolicy.realpath(), so fixtures use the same canonical identity.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  disposableRoots.add(root);
  return root;
}

export async function initializedProject(title = "Protocol test"): Promise<string> {
  const root = await temporaryDirectory();
  await initializeProject(root, title);
  return root;
}

export async function acceptedProjectWithFiles(
  files: Readonly<Record<string, string>>,
  title = "Accepted protocol test"
): Promise<string> {
  const root = await initializedProject(title);
  const relativePaths = Object.keys(files).sort();
  for (const relativePath of relativePaths) {
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, files[relativePath]!, "utf8");
  }
  await freezePacket(root, "accepted-inputs", relativePaths);
  const verification = await verifyProject(root);
  expect(verification.passed).toBe(true);
  await writeFile(
    path.join(root, "ACCEPTANCE.yaml"),
    `version: 1\ncommands: []\nhuman_approvals:\n  - id: scientific-acceptance\n    required: true\n    status: approved\n    authority: test-authority\n    accepts:\n      verification_event_id: ${verification.verification_event_id}\n      verification_event_hash: ${verification.verification_event_hash}\n    note: Accepted only for this isolated test fixture.\n`,
    "utf8"
  );
  await recordAcceptance(root, "test-authority", "Accepted the exact frozen fixture bytes.");
  return root;
}

export async function expectErrorCode(
  operation: Promise<unknown>,
  code: string
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

export async function eventFiles(root: string): Promise<string[]> {
  return (await readdir(path.join(root, ".research", "events")))
    .filter((name) => /^\d{8}-[0-9a-f-]{36}\.json$/.test(name))
    .sort();
}

export async function eventsForRun(root: string, runId: string): Promise<CommittedEvent[]> {
  return (await readEvents(root)).filter((event) => event.run_id === runId);
}

export async function readUtf8(root: string, relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}
