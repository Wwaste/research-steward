import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  assertNonSensitiveArtifactPath,
  ensurePrivateDirectoryInside,
  resolveExistingInside,
  resolvePrivateDestinationInside,
  resolvePrivateExistingInside,
  validateRelativePath
} from "./paths.js";
import {
  appendEvent,
  loadPacket,
  readEvents,
  unresolvedBlockedEvents,
  withProtocolLock
} from "./store.js";
import {
  ResearchStewardError,
  atomicWriteFile,
  sha256File,
  sha256Text,
  stableJson,
  syncFile,
  syncParentDirectory
} from "./utils.js";

const HandoffFileSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

const PackageProvenanceSchema = z
  .object({
    packet_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    packet_hash: z.string().regex(/^[a-f0-9]{64}$/),
    packet_event_id: z.string().uuid(),
    verification_event_id: z.string().uuid(),
    acceptance_event_id: z.string().uuid(),
    acceptance_document_sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

const InternalManifestSchema = z
  .object({
    version: z.literal(1),
    project_id: z.string().uuid(),
    package_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    status: z.literal("packaged"),
    created_at: z.string().datetime({ offset: true }),
    provenance: PackageProvenanceSchema,
    files: z.array(HandoffFileSchema).min(1).max(1_000),
    excluded: z.array(z.string().min(1).max(200)).max(32)
  })
  .strict();

const PackageJournalSchema = z
  .object({
    version: z.literal(1),
    archive_path: z.string().min(1).max(4_096),
    archive_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    internal: InternalManifestSchema
  })
  .strict();

type HandoffFile = z.infer<typeof HandoffFileSchema>;
type PackageProvenance = z.infer<typeof PackageProvenanceSchema>;
type InternalManifest = z.infer<typeof InternalManifestSchema>;
type PackageJournal = z.infer<typeof PackageJournalSchema>;

interface PackageResult {
  package_id: string;
  archive_path: string;
  archive_sha256: string;
  files: HandoffFile[];
  clean_room_verified: boolean;
}

function safeName(relativePath: string): void {
  assertNonSensitiveArtifactPath(relativePath, "package");
}

function runTar(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn("tar", [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
      env: {
        PATH: process.env["PATH"],
        LANG: process.env["LANG"] ?? "C",
        LC_ALL: "C"
      }
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const terminateTree = (signal: NodeJS.Signals): void => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The tar process tree may already have exited.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree("SIGTERM");
      killTimer = setTimeout(() => terminateTree("SIGKILL"), 2_000);
      killTimer.unref();
    }, 120_000);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) {
        outputLimitExceeded = true;
        terminateTree("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 1_000_000) {
        outputLimitExceeded = true;
        terminateTree("SIGTERM");
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      reject(
        new ResearchStewardError("TAR_SPAWN_FAILED", "Unable to start the local tar process.", {
          error_name: error.name,
          error_code: (error as NodeJS.ErrnoException).code ?? "unknown"
        })
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      const details = {
        exit_code: code,
        signal,
        stdout_length: stdout.length,
        stdout_sha256: sha256Text(stdout),
        stderr_length: stderr.length,
        stderr_sha256: sha256Text(stderr)
      };
      if (timedOut) {
        reject(new ResearchStewardError("TAR_TIMEOUT", "tar exceeded its 120 second deadline.", details));
        return;
      }
      if (outputLimitExceeded) {
        reject(
          new ResearchStewardError(
            "TAR_OUTPUT_LIMIT",
            "tar exceeded the bounded diagnostic output limit.",
            details
          )
        );
        return;
      }
      if (code !== 0) {
        reject(new ResearchStewardError("TAR_FAILED", "tar exited unsuccessfully.", details));
        return;
      }
      resolve(stdout);
    });
  });
}

function normalizedArchiveEntry(rawLine: string): string {
  return rawLine.replace(/^\.\//, "").replace(/\/$/, "");
}

function expectedArchiveEntries(expected: InternalManifest): Set<string> {
  const entries = new Set(["", "HANDOFF_MANIFEST.yaml", "payload"]);
  for (const file of expected.files) {
    const payloadPath = `payload/${file.path}`;
    entries.add(payloadPath);
    let parent = path.posix.dirname(payloadPath);
    while (parent !== "." && parent !== "") {
      entries.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return entries;
}

function validateArchiveListing(listing: string, expected: InternalManifest): void {
  const seen = new Set<string>();
  for (const rawLine of listing.split("\n").filter(Boolean)) {
    const line = normalizedArchiveEntry(rawLine);
    if (path.isAbsolute(line)) {
      throw new ResearchStewardError("ARCHIVE_ABSOLUTE_PATH", `Archive contains absolute path: ${line}`);
    }
    const components = line.split("/");
    if (components.includes("..")) {
      throw new ResearchStewardError("ARCHIVE_PATH_TRAVERSAL", `Archive contains traversal path: ${line}`);
    }
    if (seen.has(line)) {
      throw new ResearchStewardError("ARCHIVE_DUPLICATE_ENTRY", `Archive repeats an entry: ${line}`);
    }
    seen.add(line);
  }
  const expectedEntries = expectedArchiveEntries(expected);
  const extra = [...seen].filter((entry) => !expectedEntries.has(entry));
  const missing = [...expectedEntries].filter((entry) => !seen.has(entry));
  if (extra.length > 0 || missing.length > 0) {
    throw new ResearchStewardError(
      "ARCHIVE_ENTRY_SET_MISMATCH",
      "Archive entries do not exactly match the handoff manifest.",
      { extra_entries: extra, missing_entries: missing }
    );
  }
}

async function inspectExtractedTree(
  directory: string,
  relative = "",
  entries = new Set<string>(),
  inodes = new Set<string>()
): Promise<Set<string>> {
  if (relative === "") entries.add("");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = path.join(directory, entry.name);
    const info = await lstat(child);
    if (info.isSymbolicLink()) {
      throw new ResearchStewardError(
        "ARCHIVE_LINK_ENTRY",
        `Extracted archive contains a symbolic link: ${childRelative}`
      );
    }
    if (info.isDirectory()) {
      entries.add(childRelative);
      await inspectExtractedTree(child, childRelative, entries, inodes);
      continue;
    }
    if (!info.isFile()) {
      throw new ResearchStewardError(
        "ARCHIVE_SPECIAL_ENTRY",
        `Extracted archive contains a special entry: ${childRelative}`
      );
    }
    const inode = `${String(info.dev)}:${String(info.ino)}`;
    if (inodes.has(inode)) {
      throw new ResearchStewardError(
        "ARCHIVE_HARDLINK_ENTRY",
        `Extracted archive contains hard-linked regular files: ${childRelative}`
      );
    }
    inodes.add(inode);
    entries.add(childRelative);
  }
  return entries;
}

async function cleanRoomVerify(archivePath: string, expected: InternalManifest): Promise<void> {
  const listing = await runTar(["-tzf", archivePath], path.dirname(archivePath));
  validateArchiveListing(listing, expected);
  const cleanRoot = await mkdtemp(path.join(os.tmpdir(), "research-steward-handoff-"));
  try {
    await runTar(["-xzf", archivePath, "-C", cleanRoot], path.dirname(archivePath));
    const extractedEntries = await inspectExtractedTree(cleanRoot);
    const expectedEntries = expectedArchiveEntries(expected);
    if (stableJson([...extractedEntries].sort()) !== stableJson([...expectedEntries].sort())) {
      throw new ResearchStewardError(
        "ARCHIVE_EXTRACTED_SET_MISMATCH",
        "Extracted entries do not exactly match the handoff manifest."
      );
    }
    const parsed = InternalManifestSchema.parse(
      parseYaml(await readFile(path.join(cleanRoot, "HANDOFF_MANIFEST.yaml"), "utf8"))
    );
    if (stableJson(parsed) !== stableJson(expected)) {
      throw new ResearchStewardError(
        "HANDOFF_MANIFEST_MISMATCH",
        "Extracted handoff manifest does not exactly match the commit journal."
      );
    }
    for (const file of expected.files) {
      const extracted = path.join(cleanRoot, "payload", file.path);
      const [info, hash] = await Promise.all([stat(extracted), sha256File(extracted)]);
      if (!info.isFile() || info.size !== file.size || hash !== file.sha256) {
        throw new ResearchStewardError("HANDOFF_FILE_MISMATCH", `Extracted handoff file failed verification: ${file.path}`);
      }
    }
  } finally {
    await rm(cleanRoot, { recursive: true, force: true });
  }
}

async function resolvePackageProvenance(
  root: string,
  requestedPaths: readonly string[]
): Promise<{
  provenance: PackageProvenance;
  packet: Awaited<ReturnType<typeof loadPacket>>;
}> {
  const events = await readEvents(root);
  const acceptance = [...events]
    .reverse()
    .find((event) => event.type === "acceptance" && event.status === "complete");
  if (!acceptance) {
    throw new ResearchStewardError(
      "ACCEPTANCE_REQUIRED",
      "Packaging requires a named, committed scientific acceptance event."
    );
  }
  if (unresolvedBlockedEvents(events).length > 0) {
    throw new ResearchStewardError(
      "UNRESOLVED_BLOCKER",
      "A blocker recorded after acceptance must be resolved before packaging."
    );
  }
  const invalidatingEvents = events.filter(
    (event) =>
      event.sequence > acceptance.sequence &&
      !(
        event.type === "package_created" &&
        event.depends_on.includes(acceptance.event_id)
      )
  );
  if (invalidatingEvents.length > 0) {
    throw new ResearchStewardError(
      "ACCEPTANCE_NOT_CURRENT",
      "Research events changed after acceptance; verify and obtain a new named acceptance before packaging."
    );
  }
  const verification = events.find(
    (event) =>
      acceptance.depends_on.includes(event.event_id) &&
      event.type === "verification" &&
      event.status === "complete" &&
      event.metadata["passed"] === true
  );
  if (!verification) {
    throw new ResearchStewardError(
      "ACCEPTANCE_VERIFICATION_MISMATCH",
      "Acceptance must depend on a passing deterministic verification event."
    );
  }
  const acceptanceDocumentHash = acceptance.metadata["acceptance_document_sha256"];
  if (typeof acceptanceDocumentHash !== "string" || !/^[a-f0-9]{64}$/.test(acceptanceDocumentHash)) {
    throw new ResearchStewardError(
      "ACCEPTANCE_DOCUMENT_UNBOUND",
      "Acceptance event does not bind the exact ACCEPTANCE.yaml bytes."
    );
  }
  const currentAcceptancePath = await resolveExistingInside(root, "ACCEPTANCE.yaml");
  if ((await sha256File(currentAcceptancePath)) !== acceptanceDocumentHash) {
    throw new ResearchStewardError(
      "ACCEPTANCE_DOCUMENT_CHANGED",
      "ACCEPTANCE.yaml changed after scientific acceptance; verify and accept the new document before packaging."
    );
  }

  const packetEvents = events
    .filter(
      (event) =>
        event.type === "packet_frozen" &&
        event.sequence < verification.sequence &&
        verification.depends_on.includes(event.event_id)
    )
    .reverse();
  for (const packetEvent of packetEvents) {
    const packetId = packetEvent.metadata["packet_id"];
    if (typeof packetId !== "string") continue;
    const packet = await loadPacket(root, packetId);
    const packetPaths = packet.files.map((file) => file.path).sort();
    if (stableJson(packetPaths) !== stableJson([...requestedPaths].sort())) continue;
    for (const file of packet.files) {
      const current = await resolveExistingInside(root, file.path);
      if ((await sha256File(current)) !== file.sha256) {
        throw new ResearchStewardError(
          "ACCEPTED_SOURCE_CHANGED",
          `Source ${file.path} changed after the accepted packet was frozen.`
        );
      }
    }
    return {
      packet,
      provenance: PackageProvenanceSchema.parse({
        packet_id: packet.packet_id,
        packet_hash: packet.packet_hash,
        packet_event_id: packetEvent.event_id,
        verification_event_id: verification.event_id,
        acceptance_event_id: acceptance.event_id,
        acceptance_document_sha256: acceptanceDocumentHash
      })
    };
  }
  throw new ResearchStewardError(
    "ACCEPTED_PACKET_NOT_FOUND",
    "No packet verified before acceptance exactly matches the requested handoff file set."
  );
}

async function finalizePublishedPackage(
  root: string,
  archivePath: string,
  journal: PackageJournal
): Promise<PackageResult> {
  const canonicalManifest = {
    ...journal.internal,
    package: {
      format: "tar.gz",
      path: journal.archive_path,
      sha256: journal.archive_sha256,
      clean_room_verified: true
    },
    delivery: {
      status: "not_delivered",
      destination: "",
      receipt: "",
      verified: false
    }
  };
  await atomicWriteFile(
    path.join(root, "HANDOFF_MANIFEST.yaml"),
    stringifyYaml(canonicalManifest, { lineWidth: 0 })
  );
  const events = await readEvents(root);
  const existing = events.find(
    (event) =>
      event.type === "package_created" &&
      event.metadata["package_id"] === journal.internal.package_id &&
      event.metadata["archive_sha256"] === journal.archive_sha256
  );
  if (!existing) {
    await appendEvent(root, {
      type: "package_created",
      actor: { id: "research-steward", role: "packager" },
      input_hash: journal.internal.provenance.packet_hash,
      depends_on: [journal.internal.provenance.acceptance_event_id],
      summary: `Created and clean-room verified handoff package ${journal.internal.package_id}.`,
      evidence: [
        {
          locator: `${journal.archive_path}#sha256=${journal.archive_sha256}`,
          kind: "artifact"
        }
      ],
      metadata: {
        package_id: journal.internal.package_id,
        archive_sha256: journal.archive_sha256,
        file_count: journal.internal.files.length,
        clean_room_verified: true,
        delivered: false,
        ...journal.internal.provenance
      }
    });
  }
  return {
    package_id: journal.internal.package_id,
    archive_path: path.relative(root, archivePath).split(path.sep).join("/"),
    archive_sha256: journal.archive_sha256,
    files: journal.internal.files,
    clean_room_verified: true
  };
}

async function recoverPublishedPackage(
  root: string,
  archivePath: string,
  journalPath: string,
  packageId: string,
  requestedPaths: readonly string[]
): Promise<PackageResult> {
  const journal = PackageJournalSchema.parse(
    JSON.parse(await readFile(journalPath, "utf8"))
  );
  if (
    journal.internal.package_id !== packageId ||
    stableJson(journal.internal.files.map((file) => file.path).sort()) !==
      stableJson([...requestedPaths].sort())
  ) {
    throw new ResearchStewardError(
      "PACKAGE_RECOVERY_IDENTITY_MISMATCH",
      "Existing package journal does not match this recovery request."
    );
  }
  if ((await sha256File(archivePath)) !== journal.archive_sha256) {
    throw new ResearchStewardError(
      "PACKAGE_ARCHIVE_HASH_MISMATCH",
      "Published package no longer matches its commit journal."
    );
  }
  await cleanRoomVerify(archivePath, journal.internal);
  return finalizePublishedPackage(root, archivePath, journal);
}

export async function packageHandoff(
  root: string,
  packageId: string,
  rawFiles: readonly string[]
): Promise<PackageResult> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(packageId)) {
    throw new ResearchStewardError("INVALID_PACKAGE_ID", "Package ID must be lowercase letters, digits, or hyphens.");
  }
  if (rawFiles.length === 0 || rawFiles.length > 1_000) {
    throw new ResearchStewardError("INVALID_PACKAGE_FILES", "A handoff must contain 1-1000 explicit files.");
  }
  const requestedPaths = [...new Set(rawFiles)].sort();
  for (const relativePath of requestedPaths) safeName(relativePath);
  return withProtocolLock(root, "package-publication", () =>
    packageHandoffLocked(root, packageId, requestedPaths)
  );
}

async function packageHandoffLocked(
  root: string,
  packageId: string,
  requestedPaths: readonly string[]
): Promise<PackageResult> {
  const projectManifestPath = await resolvePrivateExistingInside(
    root,
    ".research/manifest.json"
  );
  const manifestRaw = JSON.parse(
    await readFile(projectManifestPath, "utf8")
  ) as { project_id?: unknown };
  if (
    typeof manifestRaw.project_id !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(manifestRaw.project_id)
  ) {
    throw new ResearchStewardError("INVALID_MANIFEST", "Project manifest has no project ID.");
  }

  await ensurePrivateDirectoryInside(root, ".research/packages");
  const archivePath = await resolvePrivateDestinationInside(
    root,
    `.research/packages/${packageId}.tar.gz`
  );
  const journalPath = await resolvePrivateDestinationInside(
    root,
    `.research/packages/${packageId}.commit.json`
  );
  let archiveExists = false;
  try {
    await stat(archivePath);
    archiveExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (archiveExists) {
    const events = await readEvents(root);
    if (
      events.some(
        (event) =>
          event.type === "package_created" && event.metadata["package_id"] === packageId
      )
    ) {
      throw new ResearchStewardError("PACKAGE_EXISTS", `Package already exists: ${packageId}`);
    }
    const existingJournal = await resolvePrivateExistingInside(
      root,
      `.research/packages/${packageId}.commit.json`
    );
    return recoverPublishedPackage(
      root,
      archivePath,
      existingJournal,
      packageId,
      requestedPaths
    );
  }

  const { provenance, packet } = await resolvePackageProvenance(root, requestedPaths);
  const packetFiles = new Map(packet.files.map((file) => [file.path, file]));

  const stagingName = `.${packageId}.${randomUUID()}.tmp`;
  const staging = await ensurePrivateDirectoryInside(
    root,
    `.research/packages/${stagingName}`
  );
  const temporaryArchive = await resolvePrivateDestinationInside(
    root,
    `.research/packages/.${packageId}.${randomUUID()}.tar.gz.tmp`
  );
  let archiveCommitted = false;
  await ensurePrivateDirectoryInside(root, `.research/packages/${stagingName}/payload`);
  try {
    const files: HandoffFile[] = [];
    let totalBytes = 0;
    for (const relativePath of requestedPaths) {
      const expected = packetFiles.get(relativePath);
      if (!expected) {
        throw new ResearchStewardError(
          "PACKET_FILE_MISSING",
          `Accepted packet does not contain ${relativePath}.`
        );
      }
      if (expected.size > 512 * 1024 * 1024) {
        throw new ResearchStewardError(
          "PACKAGE_FILE_TOO_LARGE",
          `Handoff file exceeds the 512 MiB per-file limit: ${relativePath}`
        );
      }
      totalBytes += expected.size;
      if (totalBytes > 2 * 1024 * 1024 * 1024) {
        throw new ResearchStewardError(
          "PACKAGE_TOTAL_TOO_LARGE",
          "Handoff payload exceeds the 2 GiB total limit."
        );
      }
      const source = await resolvePrivateExistingInside(
        root,
        `.research/frozen/${packet.packet_id}/files/${relativePath}`
      );
      const info = await stat(source);
      if (!info.isFile()) {
        throw new ResearchStewardError("PACKAGE_NOT_FILE", `Handoff entry is not a regular file: ${relativePath}`);
      }
      const destination = path.join(staging, "payload", relativePath);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
      const [copiedHash, copiedInfo] = await Promise.all([
        sha256File(destination),
        stat(destination)
      ]);
      if (copiedHash !== expected.sha256 || copiedInfo.size !== expected.size) {
        throw new ResearchStewardError(
          "COPY_HASH_MISMATCH",
          `Copied handoff file hash mismatch: ${relativePath}`
        );
      }
      files.push({
        path: relativePath.split(path.sep).join("/"),
        size: copiedInfo.size,
        sha256: copiedHash
      });
    }

    const internal = InternalManifestSchema.parse({
      version: 1,
      project_id: manifestRaw.project_id,
      package_id: packageId,
      status: "packaged",
      created_at: new Date().toISOString(),
      provenance,
      files,
      excluded: [
        "credentials",
        "provider sessions",
        "temporary files",
        "hidden chain-of-thought",
        "unrelated private data"
      ]
    });
    await atomicWriteFile(
      path.join(staging, "HANDOFF_MANIFEST.yaml"),
      stringifyYaml(internal, { lineWidth: 0 })
    );
    await runTar(["-czf", temporaryArchive, "-C", staging, "."], root);
    await syncFile(temporaryArchive);
    const archiveHash = await sha256File(temporaryArchive);
    await cleanRoomVerify(temporaryArchive, internal);
    if ((await sha256File(temporaryArchive)) !== archiveHash) {
      throw new ResearchStewardError(
        "ARCHIVE_CHANGED_DURING_VERIFICATION",
        "Handoff archive changed while it was being verified."
      );
    }

    const journal = PackageJournalSchema.parse({
      version: 1,
      archive_path: path.relative(root, archivePath).split(path.sep).join("/"),
      archive_sha256: archiveHash,
      internal
    });
    await atomicWriteFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

    // A hard link is an atomic, no-clobber publication primitive on the same
    // filesystem. Exactly one concurrent packager can claim the package ID.
    try {
      await link(temporaryArchive, archivePath);
      archiveCommitted = true;
      await syncParentDirectory(archivePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ResearchStewardError("PACKAGE_EXISTS", `Package already exists: ${packageId}`);
      }
      throw error;
    }
    await unlink(temporaryArchive);
    return await finalizePublishedPackage(root, archivePath, journal);
  } catch (error) {
    // Once published, the archive belongs to this package ID. Never remove it
    // from a losing or later-failing concurrent process.
    if (archiveCommitted) {
      throw new ResearchStewardError(
        "PACKAGE_PUBLISHED_METADATA_FAILED",
        "The verified archive was published, but metadata finalization failed; the archive was preserved.",
        {
          package_id: packageId,
          archive_path: path.relative(root, archivePath).split(path.sep).join("/"),
          cause_code: error instanceof ResearchStewardError ? error.code : "unknown"
        }
      );
    }
    throw error;
  } finally {
    await rm(temporaryArchive, { force: true }).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
