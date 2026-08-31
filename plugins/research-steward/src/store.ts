import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat
} from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parse as parseYaml } from "yaml";
import {
  acquireDirectoryLease,
  type DirectoryLease
} from "./directory-lease.js";
import {
  CommittedEventSchema,
  EventDraftSchema,
  FrozenPacketSchema,
  MAX_EVENT_BYTES,
  PROTOCOL_VERSION,
  ProjectManifestSchema,
  type CommittedEvent,
  type EventDraft,
  type FrozenPacket,
  type ProjectManifest,
  type VerificationCheck,
  type VerificationReport
} from "./protocol.js";
import {
  assertNonSensitiveArtifactPath,
  ensurePrivateDirectoryInside,
  resolveExistingInside,
  resolvePrivateDestinationInside,
  resolvePrivateExistingInside,
  validateRelativePath
} from "./paths.js";
import {
  ResearchStewardError,
  atomicWriteFile,
  errorMessage,
  sha256File,
  sha256Text,
  stableJson,
  syncFile,
  syncParentDirectory,
  writeImmutableFile
} from "./utils.js";

const RESEARCH_DIRECTORY = ".research";
const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 25;
const LOCK_ATTEMPTS = 400;

const canonicalTemplates: Record<string, (title: string, projectId: string) => string> = {
  "STATUS.md": (title, projectId) => `# Status: ${title}

- Project ID: \`${projectId}\`
- State: \`draft\`
- Authority: generated from committed Research Steward events
- Last update: project initialization

Do not advance state by editing this file alone.
`,
  "TASK.md": (title) => `# Task: ${title}

## Objective

Define the concrete research outcome.

## In scope

- Add scoped work here.

## Out of scope

- Add explicit exclusions here.

## Inputs and authority

- Name canonical sources and the person or process authorized to accept scientific judgment.

## Constraints and open questions

- Record constraints, uncertainties, and blockers.
`,
  "DECISIONS.md": () => `# Decisions

This materialized view is generated from adjudication and acceptance events.
Add proposed decisions through the event protocol so provenance remains intact.
`,
  "ACCEPTANCE.yaml": () => `version: 1
commands: []
human_approvals:
  - id: scientific-acceptance
    required: true
    status: pending
    authority: ""
    accepts:
      verification_event_id: ""
      verification_event_hash: ""
    note: "Deterministic checks do not establish scientific correctness."
`,
  "HANDOFF_MANIFEST.yaml": (_title, projectId) => `version: 1
project_id: "${projectId}"
status: not_packaged
package:
  path: ""
  sha256: ""
files: []
delivery:
  destination: ""
  receipt: ""
  verified: false
`
};

interface AcceptanceCommand {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  timeout_ms?: number;
  required?: boolean;
}

interface AcceptanceDocument {
  version?: number;
  commands?: AcceptanceCommand[];
  human_approvals?: Array<{
    id?: string;
    required?: boolean;
    status?: string;
    authority?: string;
    accepts?: {
      verification_event_id?: string;
      verification_event_hash?: string;
    };
    note?: string;
  }>;
}

interface LedgerHeadWithoutHash {
  version: 1;
  project_id: string;
  event_count: number;
  last_sequence: number;
  last_event_hash: string | null;
}

interface LedgerHead extends LedgerHeadWithoutHash {
  head_hash: string;
}

function researchPath(root: string, ...segments: string[]): string {
  return path.join(root, RESEARCH_DIRECTORY, ...segments);
}

async function readManifest(root: string): Promise<ProjectManifest> {
  const manifestPath = await resolvePrivateExistingInside(root, ".research/manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  return ProjectManifestSchema.parse(JSON.parse(raw));
}

function makeLedgerHead(value: LedgerHeadWithoutHash): LedgerHead {
  return { ...value, head_hash: sha256Text(stableJson(value)) };
}

async function readLedgerHead(root: string, projectId: string): Promise<LedgerHead> {
  const headPath = await resolvePrivateExistingInside(root, ".research/ledger-head.json");
  const parsed = JSON.parse(await readFile(headPath, "utf8")) as Partial<LedgerHead>;
  const { head_hash: storedHash, ...withoutHash } = parsed;
  if (
    parsed.version !== 1 ||
    parsed.project_id !== projectId ||
    !Number.isInteger(parsed.event_count) ||
    (parsed.event_count ?? -1) < 0 ||
    !Number.isInteger(parsed.last_sequence) ||
    (parsed.last_sequence ?? -1) < 0 ||
    !(
      parsed.last_event_hash === null ||
      (typeof parsed.last_event_hash === "string" && /^[a-f0-9]{64}$/.test(parsed.last_event_hash))
    ) ||
    typeof storedHash !== "string" ||
    sha256Text(stableJson(withoutHash)) !== storedHash
  ) {
    throw new ResearchStewardError("INVALID_LEDGER_HEAD", "Ledger head is missing, malformed, or inconsistent.");
  }
  return parsed as LedgerHead;
}

async function writeLedgerHead(root: string, head: LedgerHeadWithoutHash): Promise<void> {
  const headPath = await resolvePrivateDestinationInside(root, ".research/ledger-head.json");
  await atomicWriteFile(headPath, `${JSON.stringify(makeLedgerHead(head), null, 2)}\n`);
}

async function createTextIfAbsent(filePath: string, contents: string): Promise<boolean> {
  try {
    await writeImmutableFile(filePath, contents);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function withDirectoryLock<T>(
  root: string,
  lockName: string,
  operation: (lease: DirectoryLease) => Promise<T>
): Promise<T> {
  if (!/^\.[a-z0-9.-]+-lock$/.test(lockName)) {
    throw new ResearchStewardError("INVALID_LOCK_NAME", "Protocol lock name is invalid.");
  }
  const timeoutError = () =>
    new ResearchStewardError("LOCK_TIMEOUT", "Timed out waiting for the project event lock.");
  const lease = await acquireDirectoryLease({
    root,
    relative_path: `.research/${lockName}`,
    stale_ms: LOCK_STALE_MS,
    heartbeat_ms: 5_000,
    attempts: LOCK_ATTEMPTS,
    wait_ms: LOCK_WAIT_MS,
    active_error: timeoutError,
    exhausted_error: timeoutError
  });
  try {
    await lease.assertOwned();
    return await operation(lease);
  } finally {
    await lease.release();
  }
}

async function withEventLock<T>(
  root: string,
  operation: (lease: DirectoryLease) => Promise<T>
): Promise<T> {
  return withDirectoryLock(root, ".event-lock", operation);
}

async function withRenderLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return withDirectoryLock(root, ".render-lock", async () => operation());
}

export async function withProtocolLock<T>(
  root: string,
  resourceId: string,
  operation: () => Promise<T>
): Promise<T> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(resourceId)) {
    throw new ResearchStewardError("INVALID_LOCK_RESOURCE", "Protocol lock resource is invalid.");
  }
  return withDirectoryLock(root, `.resource-${resourceId}-lock`, async () => operation());
}

function eventHash(eventWithoutHash: Omit<CommittedEvent, "event_hash">): string {
  return sha256Text(stableJson(eventWithoutHash));
}

export async function readEvents(root: string): Promise<CommittedEvent[]> {
  const manifest = await readManifest(root);
  const head = await readLedgerHead(root, manifest.project_id);
  const directory = await resolvePrivateExistingInside(root, ".research/events");
  const names = (await readdir(directory)).filter((name) => /^\d{8}-[0-9a-f-]{36}\.json$/.test(name));
  const events: CommittedEvent[] = [];

  for (const name of names) {
    const filePath = await resolvePrivateExistingInside(root, `.research/events/${name}`);
    const info = await stat(filePath);
    if (info.size > MAX_EVENT_BYTES) {
      throw new ResearchStewardError("EVENT_TOO_LARGE", `Event exceeds size limit: ${name}`);
    }
    const parsed = CommittedEventSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    const fileSequence = Number.parseInt(name.slice(0, 8), 10);
    if (fileSequence !== parsed.sequence) {
      throw new ResearchStewardError("EVENT_FILENAME_MISMATCH", `Event filename does not match its sequence: ${name}`);
    }
    const { event_hash: storedHash, ...withoutHash } = parsed;
    const actualHash = eventHash(withoutHash);
    if (storedHash !== actualHash) {
      throw new ResearchStewardError("EVENT_HASH_MISMATCH", `Event hash mismatch: ${name}`);
    }
    events.push(parsed);
  }

  events.sort((left, right) => left.sequence - right.sequence);
  const seenSequences = new Set<number>();
  const seenIds = new Set<string>();
  let previousHash: string | null = null;
  for (const [index, event] of events.entries()) {
    if (seenSequences.has(event.sequence) || seenIds.has(event.event_id)) {
      throw new ResearchStewardError("DUPLICATE_EVENT", "Duplicate event sequence or ID detected.");
    }
    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence) {
      throw new ResearchStewardError(
        "EVENT_SEQUENCE_GAP",
        `Expected event sequence ${expectedSequence}, found ${event.sequence}.`
      );
    }
    if (event.project_id !== manifest.project_id) {
      throw new ResearchStewardError(
        "EVENT_PROJECT_MISMATCH",
        `Event ${event.event_id} belongs to a different project.`
      );
    }
    if (event.previous_event_hash !== previousHash) {
      throw new ResearchStewardError(
        "EVENT_CHAIN_MISMATCH",
        `Event ${event.event_id} does not extend the previous committed hash.`
      );
    }
    for (const dependency of event.depends_on) {
      if (!seenIds.has(dependency)) {
        throw new ResearchStewardError(
          "INVALID_EVENT_DEPENDENCY",
          `Event ${event.event_id} depends on an unknown or non-prior event.`
        );
      }
    }
    seenSequences.add(event.sequence);
    seenIds.add(event.event_id);
    previousHash = event.event_hash;
  }
  if (
    head.event_count !== events.length ||
    head.last_sequence !== (events.at(-1)?.sequence ?? 0) ||
    head.last_event_hash !== (events.at(-1)?.event_hash ?? null)
  ) {
    throw new ResearchStewardError(
      "LEDGER_HEAD_MISMATCH",
      "Ledger files do not match the durable tail anchor."
    );
  }
  return events;
}

export async function appendEvent(root: string, rawDraft: EventDraft): Promise<CommittedEvent> {
  const manifest = await readManifest(root);
  const draft = EventDraftSchema.parse(rawDraft);
  if (
    draft.decisions.length > 0 &&
    !["adjudication", "acceptance"].includes(draft.type)
  ) {
    throw new ResearchStewardError(
      "UNAUTHORIZED_EVENT_DECISIONS",
      "Only adjudication or acceptance events may contain decisions."
    );
  }
  if (
    draft.type === "adjudication" &&
    (draft.status !== "complete" || draft.depends_on.length === 0)
  ) {
    throw new ResearchStewardError(
      "INVALID_ADJUDICATION_EVENT",
      "An adjudication event must be complete and depend on committed contributions."
    );
  }
  if (draft.type === "blocked" && draft.status !== "blocked") {
    throw new ResearchStewardError(
      "INVALID_BLOCK_EVENT",
      "A blocked event must have blocked status."
    );
  }
  if (
    draft.type === "block_resolved" &&
    (draft.status !== "complete" || draft.depends_on.length === 0)
  ) {
    throw new ResearchStewardError(
      "INVALID_BLOCK_RESOLUTION",
      "A block resolution must be complete and depend on at least one unresolved blocker."
    );
  }
  if (
    draft.type === "provisional_review" &&
    (draft.status !== "complete" || draft.depends_on.length !== 1)
  ) {
    throw new ResearchStewardError(
      "INVALID_PROVISIONAL_REVIEW",
      "A provisional review must be complete and depend on exactly one verification event."
    );
  }
  if (
    draft.visibility === "blind" &&
    (!draft.run_id ||
      typeof draft.metadata["blind_group"] !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(draft.metadata["blind_group"]))
  ) {
    throw new ResearchStewardError(
      "BLIND_GROUP_REQUIRED",
      "A blind event must name both a run ID and a valid blind_group."
    );
  }
  const findingIds = draft.findings.map((finding) => finding.id);
  if (new Set(findingIds).size !== findingIds.length) {
    throw new ResearchStewardError(
      "DUPLICATE_FINDING_ID",
      "Finding IDs must be unique within an event."
    );
  }
  const decisionIds = draft.decisions.map((decision) => decision.finding_id);
  if (new Set(decisionIds).size !== decisionIds.length) {
    throw new ResearchStewardError(
      "DUPLICATE_ADJUDICATION",
      "An adjudication event may decide each upstream finding at most once."
    );
  }

  const committed = await withEventLock(root, async (lease) => {
    const existing = await readEvents(root);
    const existingIds = new Set(existing.map((event) => event.event_id));
    const existingFindingIds = new Set(
      existing.flatMap((event) => event.findings.map((finding) => finding.id))
    );
    const repeatedProjectFindingIds = findingIds.filter((findingId) =>
      existingFindingIds.has(findingId)
    );
    if (repeatedProjectFindingIds.length > 0) {
      throw new ResearchStewardError(
        "DUPLICATE_PROJECT_FINDING_ID",
        "Finding IDs must be unique across the project ledger.",
        { finding_ids: repeatedProjectFindingIds }
      );
    }
    if (draft.type === "packet_frozen") {
      const packetId = draft.metadata["packet_id"];
      const supersedes = draft.metadata["supersedes"] ?? [];
      if (
        typeof packetId !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(packetId) ||
        !Array.isArray(supersedes) ||
        supersedes.some(
          (target) => typeof target !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(target)
        ) ||
        new Set(supersedes).size !== supersedes.length ||
        supersedes.includes(packetId)
      ) {
        throw new ResearchStewardError(
          "INVALID_PACKET_SUPERSESSION",
          "A packet_frozen event must contain a valid packet ID and distinct prior packet IDs in supersedes."
        );
      }
      const priorPacketEvents = existing.filter((event) => event.type === "packet_frozen");
      if (priorPacketEvents.some((event) => event.metadata["packet_id"] === packetId)) {
        throw new ResearchStewardError(
          "DUPLICATE_PACKET_EVENT",
          "A packet ID may have only one immutable packet_frozen event."
        );
      }
      const priorPacketIds = new Set(
        priorPacketEvents
          .map((event) => event.metadata["packet_id"])
          .filter((value): value is string => typeof value === "string")
      );
      const alreadySuperseded = new Set(
        priorPacketEvents.flatMap((event) => {
          const targets = event.metadata["supersedes"];
          return Array.isArray(targets)
            ? targets.filter((value): value is string => typeof value === "string")
            : [];
        })
      );
      const unknown = supersedes.filter((target) => !priorPacketIds.has(target));
      const inactive = supersedes.filter((target) => alreadySuperseded.has(target));
      if (unknown.length > 0) {
        throw new ResearchStewardError(
          "UNKNOWN_SUPERSEDED_PACKET",
          "A packet may supersede only an existing prior packet.",
          { packet_ids: unknown }
        );
      }
      if (inactive.length > 0) {
        throw new ResearchStewardError(
          "PACKET_ALREADY_SUPERSEDED",
          "A packet may supersede only currently active packets.",
          { packet_ids: inactive }
        );
      }
    }
    if (new Set(draft.depends_on).size !== draft.depends_on.length) {
      throw new ResearchStewardError(
        "DUPLICATE_EVENT_DEPENDENCY",
        "An event cannot repeat a dependency ID."
      );
    }
    for (const dependency of draft.depends_on) {
      if (!existingIds.has(dependency)) {
        throw new ResearchStewardError(
          "INVALID_EVENT_DEPENDENCY",
          "Every event dependency must name an existing prior event."
        );
      }
    }
    if (draft.type === "adjudication") {
      const dependencies = draft.depends_on.map((eventId) =>
        existing.find((event) => event.event_id === eventId)!
      );
      if (dependencies.some((event) => event.status !== "complete")) {
        throw new ResearchStewardError(
          "INCOMPLETE_ADJUDICATION_DEPENDENCY",
          "Adjudication dependencies must all be complete."
        );
      }
      const upstreamFindingIds = new Set(
        dependencies.flatMap((event) => event.findings.map((finding) => finding.id))
      );
      const unknownDecisionIds = draft.decisions
        .map((decision) => decision.finding_id)
        .filter((findingId) => !upstreamFindingIds.has(findingId));
      if (unknownDecisionIds.length > 0) {
        throw new ResearchStewardError(
          "ADJUDICATION_FINDING_UNKNOWN",
          "Every adjudication decision must name a finding in its dependencies.",
          { unknown_finding_ids: unknownDecisionIds }
        );
      }
      const selfAdjudicatedIds = draft.decisions
        .map((decision) => decision.finding_id)
        .filter((findingId) =>
          dependencies.some(
            (event) =>
              event.actor.id === draft.actor.id &&
              event.findings.some((finding) => finding.id === findingId)
          )
        );
      if (selfAdjudicatedIds.length > 0) {
        throw new ResearchStewardError(
          "SELF_ADJUDICATION",
          "An actor cannot author a finding and commit its authoritative disposition.",
          { finding_ids: selfAdjudicatedIds }
        );
      }
      if (upstreamFindingIds.size > 0 && draft.decisions.length === 0) {
        throw new ResearchStewardError(
          "ADJUDICATION_DECISION_REQUIRED",
          "An adjudication with upstream findings must contain at least one decision."
        );
      }
    }
    if (draft.type === "block_resolved") {
      const unresolved = new Set(
        unresolvedBlockedEvents(existing).map((event) => event.event_id)
      );
      const invalid = draft.depends_on.filter((eventId) => !unresolved.has(eventId));
      if (invalid.length > 0) {
        throw new ResearchStewardError(
          "BLOCK_RESOLUTION_TARGET_INVALID",
          "A block resolution may name only currently unresolved blocking events.",
          { invalid_event_ids: invalid }
        );
      }
    }
    if (draft.type === "provisional_review") {
      const verification = existing.find(
        (event) => event.event_id === draft.depends_on[0]
      );
      if (
        verification?.type !== "verification" ||
        verification.status !== "complete" ||
        verification.metadata["passed"] !== true
      ) {
        throw new ResearchStewardError(
          "INVALID_PROVISIONAL_REVIEW",
          "A provisional review may depend only on a passing verification event."
        );
      }
    }
    const sequence = (existing.at(-1)?.sequence ?? 0) + 1;
    const withoutHash = {
      ...draft,
      protocol_version: PROTOCOL_VERSION,
      event_id: randomUUID(),
      sequence,
      timestamp: new Date().toISOString(),
      project_id: manifest.project_id,
      previous_event_hash: existing.at(-1)?.event_hash ?? null
    } satisfies Omit<CommittedEvent, "event_hash">;
    const event = CommittedEventSchema.parse({
      ...withoutHash,
      event_hash: eventHash(withoutHash)
    });
    const fileName = `${String(sequence).padStart(8, "0")}-${event.event_id}.json`;
    const serialized = `${JSON.stringify(event, null, 2)}\n`;
    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength > MAX_EVENT_BYTES) {
      throw new ResearchStewardError(
        "EVENT_TOO_LARGE",
        `Event would exceed the ${MAX_EVENT_BYTES} byte limit.`,
        { serialized_bytes: byteLength, maximum_bytes: MAX_EVENT_BYTES }
      );
    }
    const eventPath = await resolvePrivateDestinationInside(
      root,
      `.research/events/${fileName}`
    );
    let eventWritten = false;
    try {
      await lease.assertOwned();
      await atomicWriteFile(eventPath, serialized);
      eventWritten = true;
      await lease.assertOwned();
      await writeLedgerHead(root, {
        version: 1,
        project_id: manifest.project_id,
        event_count: sequence,
        last_sequence: sequence,
        last_event_hash: event.event_hash
      });
    } catch (error) {
      if (eventWritten) {
        await rm(eventPath, { force: true }).catch(() => undefined);
      }
      throw error;
    }
    return event;
  });
  // The immutable event is authoritative. Render outside the event lock so a
  // large derived view cannot serialize otherwise independent ledger writers.
  await renderViews(root).catch(() => undefined);
  return committed;
}

export async function initializeProject(
  root: string,
  title: string
): Promise<{ manifest: ProjectManifest; created_files: string[] }> {
  if (title.trim().length === 0 || title.length > 200) {
    throw new ResearchStewardError("INVALID_TITLE", "Project title must contain 1-200 characters.");
  }

  await ensurePrivateDirectoryInside(root, ".research");
  await Promise.all([
    ensurePrivateDirectoryInside(root, ".research/events"),
    ensurePrivateDirectoryInside(root, ".research/frozen"),
    ensurePrivateDirectoryInside(root, ".research/runs"),
    ensurePrivateDirectoryInside(root, ".research/rendered")
  ]);

  const manifestPath = await resolvePrivateDestinationInside(root, ".research/manifest.json");
  let manifest: ProjectManifest;
  let manifestCreated = false;
  try {
    manifest = await readManifest(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    manifest = ProjectManifestSchema.parse({
      protocol_version: PROTOCOL_VERSION,
      project_id: randomUUID(),
      title: title.trim(),
      created_at: new Date().toISOString()
    });
    await writeImmutableFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    manifestCreated = true;
  }

  const headPath = await resolvePrivateDestinationInside(root, ".research/ledger-head.json");
  try {
    await stat(headPath);
    await readLedgerHead(root, manifest.project_id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const existingEventNames = (await readdir(researchPath(root, "events"))).filter((name) =>
      /^\d{8}-[0-9a-f-]{36}\.json$/.test(name)
    );
    if (existingEventNames.length > 0) {
      throw new ResearchStewardError(
        "LEDGER_HEAD_MISSING",
        "Cannot initialize a tail anchor over an existing unanchored ledger."
      );
    }
    await writeImmutableFile(
      headPath,
      `${JSON.stringify(
        makeLedgerHead({
          version: 1,
          project_id: manifest.project_id,
          event_count: 0,
          last_sequence: 0,
          last_event_hash: null
        }),
        null,
        2
      )}\n`
    );
  }

  const createdFiles: string[] = manifestCreated ? [`${RESEARCH_DIRECTORY}/manifest.json`] : [];
  const protectedViews: string[] = [];
  for (const [relativePath, template] of Object.entries(canonicalTemplates)) {
    if (await createTextIfAbsent(path.join(root, relativePath), template(manifest.title, manifest.project_id))) {
      createdFiles.push(relativePath);
    } else if (["STATUS.md", "DECISIONS.md"].includes(relativePath)) {
      const info = await stat(path.join(root, relativePath));
      if (info.size > 0) protectedViews.push(relativePath);
    }
  }
  try {
    const humanQueue = await stat(path.join(root, "HUMAN_REVIEW_QUEUE.md"));
    if (humanQueue.size > 0) protectedViews.push("HUMAN_REVIEW_QUEUE.md");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const viewPolicyPath = await resolvePrivateDestinationInside(root, ".research/view-policy.json");
  try {
    await stat(viewPolicyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeImmutableFile(
      viewPolicyPath,
      `${JSON.stringify({ protected_root_views: protectedViews }, null, 2)}\n`
    );
  }

  const events = await readEvents(root);
  if (events.length === 0) {
    await appendEvent(root, {
      type: "project_initialized",
      actor: { id: "research-steward", role: "coordinator" },
      summary: `Initialized research workspace for ${manifest.title}.`,
      metadata: { created_files: createdFiles }
    });
  } else {
    await renderViews(root);
  }

  return { manifest, created_files: createdFiles };
}

export function unresolvedBlockedEvents(
  events: readonly CommittedEvent[]
): CommittedEvent[] {
  const unresolved = new Map<string, CommittedEvent>();
  for (const event of events) {
    if (event.status === "blocked" || event.type === "blocked") {
      unresolved.set(event.event_id, event);
      continue;
    }
    if (event.type === "block_resolved" && event.status === "complete") {
      for (const resolvedEventId of event.depends_on) unresolved.delete(resolvedEventId);
    }
  }
  return [...unresolved.values()];
}

function deriveState(events: readonly CommittedEvent[]): string {
  let stableState = "draft";
  const unresolved = new Set<string>();
  for (const event of events) {
    if (event.status === "blocked" || event.type === "blocked") {
      unresolved.add(event.event_id);
      continue;
    }
    if (event.type === "block_resolved") {
      for (const resolvedEventId of event.depends_on) unresolved.delete(resolvedEventId);
      continue;
    }
    if (unresolved.size > 0) continue;
    switch (event.type) {
      case "project_initialized":
        stableState = "draft";
        break;
      case "candidate_declared":
        stableState = "candidate";
        break;
      case "packet_frozen":
        stableState = "frozen";
        break;
      case "run_started":
      case "agent_contribution":
      case "review_barrier_closed":
        stableState = "reviewing";
        break;
      case "adjudication":
        stableState = "adjudicated";
        break;
      case "verification":
        if (event.metadata["passed"] === true) stableState = "verified";
        break;
      case "provisional_review":
        break;
      case "acceptance":
        stableState = "accepted";
        break;
      case "package_created":
        stableState = "packaged";
        break;
      case "delivery_recorded":
        stableState = "delivered";
        break;
      case "delivery_verified":
        stableState = "delivery_verified";
        break;
    }
  }
  return unresolved.size > 0 ? "blocked" : stableState;
}

function markdownText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\0/g, "");
}

function markdownInline(value: string): string {
  return markdownText(value)
    .replace(/\s*\n\s*/g, " ")
    .replace(/([\\`*_[\]<>#])/g, "\\$1");
}

function markdownQuote(value: string): string {
  return markdownText(value)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function eventsVisibleInSharedViews(events: readonly CommittedEvent[]): CommittedEvent[] {
  const closedBlindGroups = new Set(
    events
      .filter((event) => event.type === "review_barrier_closed" && event.run_id)
      .map((event) => `${event.run_id}:${String(event.metadata["blind_group"] ?? "")}`)
  );
  return events.filter((event) => {
    if (event.visibility === "private") return false;
    if (event.visibility !== "blind") return true;
    const blindGroup = event.metadata["blind_group"];
    return (
      typeof blindGroup === "string" &&
      event.run_id !== undefined &&
      closedBlindGroups.has(`${event.run_id}:${blindGroup}`)
    );
  });
}

export async function readSharedEvents(root: string): Promise<CommittedEvent[]> {
  return eventsVisibleInSharedViews(await readEvents(root));
}

function invalidatingEventsAfterVerification(
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

async function renderViewsUnlocked(root: string): Promise<void> {
  const [manifest, events] = await Promise.all([readManifest(root), readEvents(root)]);
  const sharedEvents = eventsVisibleInSharedViews(events);
  const state = deriveState(events);
  const latest = events.at(-1);

  const status = `# Status: ${manifest.title}

- Project ID: \`${manifest.project_id}\`
- State: \`${state}\`
- Event count: ${events.length}
- Last event: ${latest ? `${latest.sequence} / ${latest.type} / ${latest.timestamp}` : "none"}
- Authority: generated from committed Research Steward events

Do not advance state by editing this file alone.
`;

  const roundtable: string[] = [
    `# Round table: ${manifest.title}`,
    "",
    "Generated from immutable events. This file is a readable view, not the authority.",
    ""
  ];
  for (const event of sharedEvents.filter((item) =>
    ["agent_contribution", "review_barrier_closed", "adjudication", "blocked"].includes(item.type)
  )) {
    roundtable.push(
      `## ${event.sequence}. ${markdownInline(event.actor.id)} — ${markdownInline(event.actor.role)}`,
      "",
      `- Event: \`${event.event_id}\``,
      `- Status: \`${event.status}\``,
      `- Visibility: \`${event.visibility}\``,
      `- Model: ${markdownInline(event.actor.adapter ?? "n/a")} / ${markdownInline(event.actor.model ?? "n/a")}`,
      `- Time: ${event.timestamp}`,
      "",
      markdownQuote(event.summary),
      ""
    );
    if (event.uncertainties.length > 0) {
      roundtable.push("### Uncertainties", "", ...event.uncertainties.map((item) => `- ${markdownInline(item)}`), "");
    }
    if (event.findings.length > 0) {
      roundtable.push("### Findings", "");
      for (const finding of event.findings) {
        roundtable.push(
          `- **${markdownInline(finding.id)} [${finding.severity}]** ${markdownInline(finding.claim)}`,
          `  - Uncertainty: ${markdownInline(finding.uncertainty || "not stated")}`,
          `  - Remediation: ${markdownInline(finding.remediation || "not stated")}`
        );
      }
      roundtable.push("");
    }
  }

  const decisions: string[] = [
    "# Decisions",
    "",
    "Generated from committed adjudication and acceptance events.",
    ""
  ];
  for (const event of sharedEvents.filter(
    (item) =>
      ["adjudication", "acceptance"].includes(item.type) &&
      item.status === "complete" &&
      item.decisions.length > 0
  )) {
    for (const decision of event.decisions) {
      decisions.push(
        `## ${markdownInline(decision.finding_id)}: ${decision.disposition}`,
        "",
        `- Event: \`${event.event_id}\``,
        `- Rationale: ${markdownInline(decision.rationale)}`,
        `- Action: ${markdownInline(decision.action || "none")}`,
        `- Owner: ${markdownInline(decision.owner || "unassigned")}`,
        `- Evidence that would change this: ${markdownInline(decision.change_evidence || "not stated")}`,
        ""
      );
    }
  }

  const latestVerification = [...events]
    .reverse()
    .find((event) => event.type === "verification");
  const acceptedLatestVerification = latestVerification
    ? events.some(
        (event) =>
          event.type === "acceptance" &&
          event.status === "complete" &&
          event.depends_on.includes(latestVerification.event_id)
      )
    : false;
  const latestVerificationInvalidators = latestVerification
    ? invalidatingEventsAfterVerification(events, latestVerification)
    : [];
  const pendingVerification =
    latestVerification?.status === "complete" &&
    latestVerification.metadata["passed"] === true &&
    !acceptedLatestVerification &&
    latestVerificationInvalidators.length === 0
      ? latestVerification
      : undefined;
  const staleVerification =
    latestVerification?.status === "complete" &&
    latestVerification.metadata["passed"] === true &&
    !acceptedLatestVerification &&
    latestVerificationInvalidators.length > 0
      ? latestVerification
      : undefined;
  const provisionalReviews = pendingVerification
    ? events.filter(
        (event) =>
          event.type === "provisional_review" &&
          event.depends_on.includes(pendingVerification.event_id)
      )
    : [];
  const blockers = unresolvedBlockedEvents(events);
  const humanQueue: string[] = [
    "# Human review queue",
    "",
    "Generated from immutable Research Steward events. AI work may continue, but provisional review never authorizes final acceptance or packaging.",
    ""
  ];
  if (pendingVerification) {
    humanQueue.push(
      "## Action required: confirm or reject the latest verification",
      "",
      "- Status: `awaiting_human_confirmation`",
      `- Verification event ID: \`${pendingVerification.event_id}\``,
      `- Verification event hash: \`${pendingVerification.event_hash}\``,
      `- Verified at: ${pendingVerification.timestamp}`,
      `- Provisional reviews: ${provisionalReviews.length}`,
      "- Human action: inspect the frozen candidate and adjudications, then copy the ID and hash above into each required `ACCEPTANCE.yaml` approval target.",
      ""
    );
    for (const review of provisionalReviews) {
      humanQueue.push(
        `### Provisional review by ${markdownInline(review.actor.id)}`,
        "",
        `- Event: \`${review.event_id}\``,
        `- Recorded: ${review.timestamp}`,
        `- Review by: ${markdownInline(String(review.metadata["review_by"] ?? "next human work session"))}`,
        "",
        markdownQuote(review.summary),
        ""
      );
    }
  }
  if (staleVerification) {
    humanQueue.push(
      "## Action required: re-run deterministic verification",
      "",
      "- Status: `reverification_required`",
      `- Superseded verification event ID: \`${staleVerification.event_id}\``,
      `- Later protocol events: ${latestVerificationInvalidators.length}`,
      "- Action: finish the current agent work, run `verify` again, and review only the newly printed ID and hash.",
      ""
    );
  }
  if (blockers.length > 0) {
    humanQueue.push("## Unresolved blockers", "");
    for (const blocker of blockers) {
      humanQueue.push(
        `- \`${blocker.event_id}\` — ${markdownInline(blocker.actor.id)} — ${blocker.timestamp} — visibility \`${blocker.visibility}\``
      );
    }
    humanQueue.push("");
  }
  if (!pendingVerification && !staleVerification && blockers.length === 0) {
    humanQueue.push("No human review item is currently pending.", "");
  }

  let protectedRootViews: string[] = [];
  try {
    const viewPolicyPath = await resolvePrivateExistingInside(
      root,
      ".research/view-policy.json"
    );
    const viewPolicy = JSON.parse(
      await readFile(viewPolicyPath, "utf8")
    ) as { protected_root_views?: unknown };
    if (Array.isArray(viewPolicy.protected_root_views)) {
      protectedRootViews = viewPolicy.protected_root_views.filter(
        (item): item is string => typeof item === "string"
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const [
    renderedStatus,
    renderedDecisions,
    renderedRoundtable,
    renderedEvents,
    renderedHumanQueue
  ] =
    await Promise.all([
      resolvePrivateDestinationInside(root, ".research/rendered/STATUS.md"),
      resolvePrivateDestinationInside(root, ".research/rendered/DECISIONS.md"),
      resolvePrivateDestinationInside(root, ".research/rendered/ROUND_TABLE.md"),
      resolvePrivateDestinationInside(root, ".research/rendered/events.jsonl"),
      resolvePrivateDestinationInside(root, ".research/rendered/HUMAN_REVIEW_QUEUE.md")
    ]);
  const writes: Array<Promise<void>> = [
    atomicWriteFile(renderedStatus, status),
    atomicWriteFile(renderedDecisions, `${decisions.join("\n")}\n`),
    atomicWriteFile(renderedRoundtable, `${roundtable.join("\n")}\n`),
    atomicWriteFile(renderedHumanQueue, `${humanQueue.join("\n")}\n`),
    atomicWriteFile(
      renderedEvents,
      sharedEvents.map((event) => JSON.stringify(event)).join("\n") +
        (sharedEvents.length > 0 ? "\n" : "")
    )
  ];
  if (!protectedRootViews.includes("STATUS.md")) {
    writes.push(atomicWriteFile(path.join(root, "STATUS.md"), status));
  }
  if (!protectedRootViews.includes("DECISIONS.md")) {
    writes.push(atomicWriteFile(path.join(root, "DECISIONS.md"), `${decisions.join("\n")}\n`));
  }
  if (!protectedRootViews.includes("HUMAN_REVIEW_QUEUE.md")) {
    writes.push(
      atomicWriteFile(path.join(root, "HUMAN_REVIEW_QUEUE.md"), `${humanQueue.join("\n")}\n`)
    );
  }
  await Promise.all(writes);
}

export async function renderViews(root: string): Promise<void> {
  await withRenderLock(root, () => renderViewsUnlocked(root));
}

function assertSafePacketFile(relativePath: string): void {
  assertNonSensitiveArtifactPath(relativePath, "freeze");
  const lower = relativePath.toLowerCase().split(path.sep).join("/");
  if (lower.startsWith(".research/frozen/")) {
    throw new ResearchStewardError("NESTED_PACKET", "A frozen packet cannot include another frozen packet.");
  }
}

export async function freezePacket(
  root: string,
  packetId: string,
  relativeFiles: readonly string[],
  supersedes: readonly string[] = []
): Promise<FrozenPacket> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(packetId)) {
    throw new ResearchStewardError("INVALID_PACKET_ID", "Packet ID must be lowercase letters, digits, or hyphens.");
  }
  if (relativeFiles.length === 0 || relativeFiles.length > 500) {
    throw new ResearchStewardError("INVALID_PACKET_FILES", "A packet must contain 1-500 files.");
  }
  if (
    supersedes.length > 500 ||
    new Set(supersedes).size !== supersedes.length ||
    supersedes.some(
      (target) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(target) || target === packetId
    )
  ) {
    throw new ResearchStewardError(
      "INVALID_PACKET_SUPERSESSION",
      "Superseded packet IDs must be distinct valid packet IDs other than the new packet."
    );
  }

  return withDirectoryLock(root, `.packet-${packetId}-lock`, () =>
    freezePacketLocked(root, packetId, relativeFiles, supersedes)
  );
}

async function freezePacketLocked(
  root: string,
  packetId: string,
  relativeFiles: readonly string[],
  supersedes: readonly string[]
): Promise<FrozenPacket> {
  const requestedPaths = [...new Set(relativeFiles)].sort();
  const requestedSupersedes = [...supersedes].sort();
  for (const relativePath of requestedPaths) assertSafePacketFile(relativePath);

  const manifest = await readManifest(root);
  await ensurePrivateDirectoryInside(root, ".research/frozen");
  const packetRoot = await resolvePrivateDestinationInside(
    root,
    `.research/frozen/${packetId}`
  );
  try {
    await stat(packetRoot);
    const existing = await loadPacket(root, packetId);
    const existingPaths = existing.files.map((file) => file.path).sort();
    if (stableJson(existingPaths) !== stableJson(requestedPaths)) {
      throw new ResearchStewardError(
        "PACKET_EXISTS",
        `Frozen packet ${packetId} already exists with a different file set.`
      );
    }
    for (const file of existing.files) {
      const currentSource = await resolveExistingInside(root, file.path);
      if ((await sha256File(currentSource)) !== file.sha256) {
        throw new ResearchStewardError(
          "PACKET_INPUT_MISMATCH",
          `Frozen packet ${packetId} already names ${file.path}, but the current source bytes differ.`
        );
      }
    }
    const events = await readEvents(root);
    const matchingEvent = events.find(
      (event) =>
        event.type === "packet_frozen" &&
        event.metadata["packet_id"] === packetId &&
        event.metadata["packet_hash"] === existing.packet_hash
    );
    if (!matchingEvent) {
      await appendPacketFrozenEvent(root, existing, requestedSupersedes);
    } else {
      const committedSupersedes = Array.isArray(matchingEvent.metadata["supersedes"])
        ? matchingEvent.metadata["supersedes"].filter(
            (value): value is string => typeof value === "string"
          ).sort()
        : [];
      if (stableJson(committedSupersedes) !== stableJson(requestedSupersedes)) {
        throw new ResearchStewardError(
          "PACKET_SUPERSESSION_MISMATCH",
          `Frozen packet ${packetId} already exists with a different supersession declaration.`
        );
      }
    }
    return existing;
  } catch (error) {
    if (error instanceof ResearchStewardError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporaryRelative = `.research/frozen/.${packetId}.${randomUUID()}.tmp`;
  const temporaryRoot = await ensurePrivateDirectoryInside(root, temporaryRelative);
  await ensurePrivateDirectoryInside(root, `${temporaryRelative}/files`);

  try {
    const packetFiles: FrozenPacket["files"] = [];
    let totalBytes = 0;
    for (const relativePath of requestedPaths) {
      const source = await resolveExistingInside(root, relativePath);
      const info = await stat(source);
      if (!info.isFile()) {
        throw new ResearchStewardError("PACKET_NOT_FILE", `Packet entry is not a regular file: ${relativePath}`);
      }
      if (info.size > 512 * 1024 * 1024) {
        throw new ResearchStewardError(
          "PACKET_FILE_TOO_LARGE",
          `Packet file exceeds the 512 MiB per-file limit: ${relativePath}`
        );
      }
      totalBytes += info.size;
      if (totalBytes > 2 * 1024 * 1024 * 1024) {
        throw new ResearchStewardError(
          "PACKET_TOTAL_TOO_LARGE",
          "Frozen packet exceeds the 2 GiB total limit."
        );
      }
      const destination = path.join(temporaryRoot, "files", relativePath);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
      await syncFile(destination);
      const [sourceHash, copiedHash, copiedInfo] = await Promise.all([
        sha256File(source),
        sha256File(destination),
        stat(destination)
      ]);
      if (sourceHash !== copiedHash) {
        throw new ResearchStewardError("COPY_HASH_MISMATCH", `Copied packet file hash mismatch: ${relativePath}`);
      }
      packetFiles.push({
        path: relativePath.split(path.sep).join("/"),
        size: copiedInfo.size,
        sha256: sourceHash
      });
    }

    const withoutHash = {
      protocol_version: PROTOCOL_VERSION,
      packet_id: packetId,
      project_id: manifest.project_id,
      created_at: new Date().toISOString(),
      files: packetFiles
    };
    const packet = FrozenPacketSchema.parse({
      ...withoutHash,
      packet_hash: sha256Text(stableJson(withoutHash))
    });
    await atomicWriteFile(
      path.join(temporaryRoot, "manifest.json"),
      `${JSON.stringify(packet, null, 2)}\n`
    );
    await rename(temporaryRoot, packetRoot);
    await syncParentDirectory(packetRoot);

    try {
      await appendPacketFrozenEvent(root, packet, requestedSupersedes);
    } catch (error) {
      await rm(packetRoot, { recursive: true, force: true });
      await syncParentDirectory(packetRoot);
      throw error;
    }

    return packet;
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function appendPacketFrozenEvent(
  root: string,
  packet: FrozenPacket,
  supersedes: readonly string[]
): Promise<void> {
  await appendEvent(root, {
    type: "packet_frozen",
    actor: { id: "research-steward", role: "freezer" },
    input_hash: packet.packet_hash,
    summary: `Frozen packet ${packet.packet_id} with ${packet.files.length} files.`,
    evidence: [
      {
        locator: `.research/frozen/${packet.packet_id}/manifest.json#sha256=${packet.packet_hash}`,
        kind: "artifact" as const
      }
    ],
    metadata: {
      packet_id: packet.packet_id,
      packet_hash: packet.packet_hash,
      file_count: packet.files.length,
      supersedes: [...supersedes]
    }
  });
}

export async function loadPacket(root: string, packetId: string): Promise<FrozenPacket> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(packetId)) {
    throw new ResearchStewardError("INVALID_PACKET_ID", "Invalid packet ID.");
  }
  const manifest = await readManifest(root);
  await resolvePrivateExistingInside(root, `.research/frozen/${packetId}`);
  const packetManifestPath = await resolvePrivateExistingInside(
    root,
    `.research/frozen/${packetId}/manifest.json`
  );
  const packet = FrozenPacketSchema.parse(
    JSON.parse(await readFile(packetManifestPath, "utf8"))
  );
  if (packet.packet_id !== packetId || packet.project_id !== manifest.project_id) {
    throw new ResearchStewardError(
      "PACKET_IDENTITY_MISMATCH",
      "Frozen packet identity does not match its directory or current project."
    );
  }
  const { packet_hash: storedHash, ...withoutHash } = packet;
  if (sha256Text(stableJson(withoutHash)) !== storedHash) {
    throw new ResearchStewardError("PACKET_MANIFEST_HASH_MISMATCH", `Packet manifest hash mismatch: ${packetId}`);
  }
  const uniquePaths = new Set<string>();
  for (const file of packet.files) {
    validateRelativePath(file.path);
    if (uniquePaths.has(file.path)) {
      throw new ResearchStewardError(
        "DUPLICATE_PACKET_PATH",
        `Frozen packet repeats a file path: ${file.path}`
      );
    }
    uniquePaths.add(file.path);
    const frozenPath = await resolvePrivateExistingInside(
      root,
      `.research/frozen/${packetId}/files/${file.path}`
    );
    const [actual, info] = await Promise.all([sha256File(frozenPath), stat(frozenPath)]);
    if (!info.isFile() || info.size !== file.size) {
      throw new ResearchStewardError(
        "PACKET_FILE_SIZE_MISMATCH",
        `Frozen file size mismatch: ${file.path}`
      );
    }
    if (actual !== file.sha256) {
      throw new ResearchStewardError("PACKET_FILE_HASH_MISMATCH", `Frozen file hash mismatch: ${file.path}`);
    }
  }
  return packet;
}

const textExtensions = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".tsv", ".tex",
  ".py", ".r", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".css"
]);

async function readUtf8Prefix(
  filePath: string,
  maximumCharacters: number
): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(filePath, "r");
  const decoder = new StringDecoder("utf8");
  let text = "";
  let position = 0;
  try {
    const info = await handle.stat();
    while (text.length < maximumCharacters && position < info.size) {
      const remaining = maximumCharacters - text.length;
      const buffer = Buffer.allocUnsafe(Math.min(65_536, Math.max(4, remaining * 4)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const decoded = decoder.write(buffer.subarray(0, bytesRead));
      text += decoded.slice(0, remaining);
      if (decoded.length > remaining) {
        return { text, truncated: true };
      }
    }
    if (position >= info.size && text.length < maximumCharacters) {
      text += decoder.end().slice(0, maximumCharacters - text.length);
    }
    return { text, truncated: position < info.size };
  } finally {
    await handle.close();
  }
}

export async function buildPacketTextBundle(
  root: string,
  packet: FrozenPacket,
  maximumCharacters: number
): Promise<string> {
  let bundle = [
    `Frozen packet: ${packet.packet_id}`,
    `Packet SHA-256: ${packet.packet_hash}`,
    "Only the bytes represented by this packet are authoritative.",
    ""
  ].join("\n");
  const truncationMarker = "\n[packet text bundle truncated by configured prompt limit]\n";

  for (const file of packet.files) {
    const extension = path.extname(file.path).toLowerCase();
    if (!textExtensions.has(extension)) {
      const note = `\n[binary omitted] ${file.path} (${file.size} bytes, sha256 ${file.sha256})\n`;
      if (bundle.length + note.length <= maximumCharacters) bundle += note;
      continue;
    }
    validateRelativePath(file.path);
    const frozenPath = await resolvePrivateExistingInside(
      root,
      `.research/frozen/${packet.packet_id}/files/${file.path}`
    );
    const header = `\n--- BEGIN ${file.path} (sha256 ${file.sha256}) ---\n`;
    const footer = `\n--- END ${file.path} ---\n`;
    const remaining =
      maximumCharacters - bundle.length - header.length - footer.length - truncationMarker.length;
    if (remaining <= 0) break;
    const included = await readUtf8Prefix(frozenPath, remaining);
    bundle += `${header}${included.text}${footer}`;
    if (included.truncated) return `${bundle}${truncationMarker}`;
  }
  return bundle;
}

async function verifyFrozenPackets(
  root: string,
  events: readonly CommittedEvent[]
): Promise<{ checks: VerificationCheck[]; dependency_event_ids: string[] }> {
  const checks: VerificationCheck[] = [];
  const packetEvents = events.filter((event) => event.type === "packet_frozen");
  const packetEventById = new Map<string, CommittedEvent>();
  const supersededBy = new Map<string, string>();
  for (const packetEvent of packetEvents) {
    const packetId = packetEvent.metadata["packet_id"];
    const supersedes = packetEvent.metadata["supersedes"] ?? [];
    if (
      typeof packetId !== "string" ||
      !Array.isArray(supersedes) ||
      supersedes.some((target) => typeof target !== "string")
    ) {
      checks.push({
        id: `packet-event:${packetEvent.event_id}:supersession`,
        status: "fail",
        message: "Packet event has malformed supersession metadata."
      });
      continue;
    }
    if (packetEventById.has(packetId)) {
      checks.push({
        id: `packet-event:${packetEvent.event_id}:identity`,
        status: "fail",
        message: "More than one packet event claims the same packet ID."
      });
    }
    for (const target of supersedes) {
      if (!packetEventById.has(target) || supersededBy.has(target)) {
        checks.push({
          id: `packet-event:${packetEvent.event_id}:supersession:${target}`,
          status: "fail",
          message: "Packet supersession must name one active prior packet exactly once."
        });
      } else {
        supersededBy.set(target, packetId);
      }
    }
    packetEventById.set(packetId, packetEvent);
  }
  const activePacketEvents = packetEvents.filter((event) => {
    const packetId = event.metadata["packet_id"];
    return typeof packetId === "string" && !supersededBy.has(packetId);
  });
  const dependencyEventIds = activePacketEvents.map((event) => event.event_id);
  const frozenRoot = await resolvePrivateExistingInside(root, ".research/frozen");
  const entries = await readdir(frozenRoot, { withFileTypes: true });
  const packetDirectories = entries.filter(
    (item) => item.isDirectory() && !item.name.startsWith(".")
  );
  const directoryNames = new Set(packetDirectories.map((entry) => entry.name));
  for (const entry of packetDirectories) {
    try {
      const packet = await loadPacket(root, entry.name);
      const matchingEvents = packetEvents.filter(
        (event) =>
          event.metadata["packet_id"] === packet.packet_id &&
          event.metadata["packet_hash"] === packet.packet_hash
      );
      checks.push({
        id: `packet:${entry.name}:event-link`,
        status: matchingEvents.length === 1 ? "pass" : "fail",
        message:
          matchingEvents.length === 1
            ? "Frozen packet has exactly one matching immutable packet event."
            : `Frozen packet has ${matchingEvents.length} matching immutable packet events; expected exactly one.`
      });
      checks.push({
        id: `packet:${entry.name}:integrity`,
        status: "pass",
        message: `Packet ${entry.name} and ${packet.files.length} frozen files match their hashes.`
      });
      const isActive = !supersededBy.has(packet.packet_id);
      if (!isActive) {
        checks.push({
          id: `packet:${entry.name}:freshness`,
          status: "not_applicable",
          message: `Packet was explicitly superseded by ${String(supersededBy.get(packet.packet_id))}; frozen-byte integrity still passed.`
        });
      }
      for (const file of isActive ? packet.files : []) {
        try {
          const current = await resolveExistingInside(root, file.path);
          const currentHash = await sha256File(current);
          checks.push({
            id: `packet:${entry.name}:source:${file.path}`,
            status: currentHash === file.sha256 ? "pass" : "fail",
            message:
              currentHash === file.sha256
                ? "Current source still matches the frozen review input."
                : "Current source changed after freeze; dependent verification is stale."
          });
        } catch (error) {
          checks.push({
            id: `packet:${entry.name}:source:${file.path}`,
            status: "fail",
            message: `Current source is unavailable: ${errorMessage(error)}`
          });
        }
      }
    } catch (error) {
      checks.push({
        id: `packet:${entry.name}:integrity`,
        status: "fail",
        message: errorMessage(error)
      });
    }
  }
  for (const packetEvent of packetEvents) {
    const packetId = packetEvent.metadata["packet_id"];
    if (typeof packetId !== "string" || !directoryNames.has(packetId)) {
      checks.push({
        id: `packet-event:${packetEvent.event_id}:storage-link`,
        status: "fail",
        message: "Immutable packet event has no matching frozen packet directory."
      });
    }
  }
  if (checks.length === 0) {
    checks.push({ id: "packets", status: "not_applicable", message: "No frozen packets exist." });
  }
  return { checks, dependency_event_ids: dependencyEventIds };
}

function verifyFindingCoverage(
  events: readonly CommittedEvent[]
): { check: VerificationCheck; dependency_event_ids: string[] } {
  const visibleEvents = eventsVisibleInSharedViews(events);
  const contributions = visibleEvents.filter(
    (event) => event.type === "agent_contribution" && event.status === "complete"
  );
  const findings = contributions.flatMap((event) =>
    event.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      event_id: event.event_id
    }))
  );
  const adjudications = visibleEvents.filter(
    (event) => event.type === "adjudication" && event.status === "complete"
  );
  const decidedIds = new Set(
    adjudications.flatMap((event) => event.decisions.map((decision) => decision.finding_id))
  );
  const unresolved = findings.filter((finding) => !decidedIds.has(finding.id));
  const dependencyEventIds = [
    ...new Set([
      ...findings.map((finding) => finding.event_id),
      ...adjudications.map((event) => event.event_id)
    ])
  ];
  if (unresolved.length === 0) {
    return {
      check: {
        id: "findings:coverage",
        status: "pass",
        message:
          findings.length === 0
            ? "No disclosed completed reviewer findings require adjudication."
            : `All ${findings.length} disclosed completed reviewer findings have an authoritative disposition.`
      },
      dependency_event_ids: dependencyEventIds
    };
  }
  const preview = unresolved
    .slice(0, 20)
    .map((finding) => `${finding.id}[${finding.severity}]`)
    .join(", ");
  return {
    check: {
      id: "findings:coverage",
      status: "fail",
      message: `${unresolved.length} disclosed completed reviewer finding(s) lack adjudication: ${preview}${
        unresolved.length > 20 ? ", …" : ""
      }`
    },
    dependency_event_ids: dependencyEventIds
  };
}

export async function verifyProject(root: string): Promise<VerificationReport> {
  const checks: VerificationCheck[] = [];
  let validatedEvents: CommittedEvent[] = [];
  let manifest: ProjectManifest;
  try {
    manifest = await readManifest(root);
    checks.push({ id: "manifest", status: "pass", message: "Project manifest is schema-valid." });
  } catch (error) {
    throw new ResearchStewardError("INVALID_MANIFEST", `Cannot verify project: ${errorMessage(error)}`);
  }

  for (const relativePath of Object.keys(canonicalTemplates)) {
    try {
      const canonicalPath = await resolveExistingInside(root, relativePath);
      const info = await stat(canonicalPath);
      checks.push({
        id: `canonical:${relativePath}`,
        status: info.isFile() && info.size > 0 ? "pass" : "fail",
        message: info.isFile() && info.size > 0 ? "Canonical file exists and is non-empty." : "Canonical file is missing or empty."
      });
    } catch {
      checks.push({ id: `canonical:${relativePath}`, status: "fail", message: "Canonical file is missing." });
    }
  }

  try {
    validatedEvents = await readEvents(root);
    checks.push({
      id: "events",
      status: validatedEvents.length > 0 ? "pass" : "fail",
      message: `${validatedEvents.length} immutable events validated with unique sequence and hash.`
    });
  } catch (error) {
    checks.push({ id: "events", status: "fail", message: errorMessage(error) });
  }

  const packetVerification = await verifyFrozenPackets(root, validatedEvents);
  checks.push(...packetVerification.checks);
  const findingCoverage = verifyFindingCoverage(validatedEvents);
  checks.push(findingCoverage.check);

  try {
    const acceptancePath = await resolveExistingInside(root, "ACCEPTANCE.yaml");
    const acceptance = parseYaml(await readFile(acceptancePath, "utf8")) as AcceptanceDocument;
    checks.push({
      id: "acceptance:syntax",
      status: acceptance.version === 1 && Array.isArray(acceptance.commands) ? "pass" : "fail",
      message: "Acceptance document parsed; command execution is a separate opt-in operation."
    });
  } catch (error) {
    checks.push({
      id: "acceptance:syntax",
      status: "fail",
      message: "Acceptance document could not be resolved and parsed safely."
    });
  }

  const reportWithoutEvent = {
    project_id: manifest.project_id,
    checked_at: new Date().toISOString(),
    passed: checks.every((check) => check.status === "pass" || check.status === "not_applicable"),
    checks
  };
  const verificationEvent = await appendEvent(root, {
    type: "verification",
    actor: { id: "research-steward", role: "deterministic-verifier" },
    depends_on: [
      ...new Set([
        ...packetVerification.dependency_event_ids,
        ...findingCoverage.dependency_event_ids
      ])
    ],
    status: reportWithoutEvent.passed ? "complete" : "failed",
    summary: reportWithoutEvent.passed
      ? "All deterministic project verification checks passed."
      : "One or more deterministic project verification checks failed.",
    uncertainties: [
      "Deterministic verification does not establish scientific correctness or human acceptance."
    ],
    metadata: {
      passed: reportWithoutEvent.passed,
      check_count: reportWithoutEvent.checks.length,
      packet_event_ids: packetVerification.dependency_event_ids,
      finding_event_ids: findingCoverage.dependency_event_ids
    }
  });
  const report: VerificationReport = {
    ...reportWithoutEvent,
    verification_event_id: verificationEvent.event_id,
    verification_event_hash: verificationEvent.event_hash
  };
  const verificationPath = await resolvePrivateDestinationInside(
    root,
    ".research/rendered/VERIFICATION.json"
  );
  await atomicWriteFile(
    verificationPath,
    `${JSON.stringify(report, null, 2)}\n`
  );
  return report;
}

export async function recordAcceptance(
  root: string,
  actorId: string,
  note: string
): Promise<CommittedEvent> {
  const acceptancePath = await resolveExistingInside(root, "ACCEPTANCE.yaml");
  const acceptanceBytes = await readFile(acceptancePath, "utf8");
  const acceptanceDocumentHash = sha256Text(acceptanceBytes);
  const acceptance = parseYaml(acceptanceBytes) as AcceptanceDocument;
  if (acceptance.version !== 1 || !Array.isArray(acceptance.human_approvals)) {
    throw new ResearchStewardError(
      "INVALID_ACCEPTANCE_DOCUMENT",
      "ACCEPTANCE.yaml must contain version 1 and human_approvals."
    );
  }
  const required = acceptance.human_approvals.filter((approval) => approval.required !== false);
  if (required.length === 0) {
    throw new ResearchStewardError(
      "NO_REQUIRED_APPROVAL",
      "At least one named human approval is required for scientific acceptance."
    );
  }
  const incomplete = required.filter(
    (approval) =>
      !["approved", "accepted"].includes((approval.status ?? "").toLowerCase()) ||
      !approval.authority?.trim()
  );
  if (incomplete.length > 0) {
    throw new ResearchStewardError(
      "HUMAN_APPROVAL_PENDING",
      "Every required human approval must be approved or accepted by a named authority."
    );
  }
  const approvalTargets = required.map((approval) => approval.accepts);
  if (
    approvalTargets.some(
      (target) =>
        !target?.verification_event_id ||
        !/^[0-9a-f-]{36}$/.test(target.verification_event_id) ||
        !target.verification_event_hash ||
        !/^[a-f0-9]{64}$/.test(target.verification_event_hash)
    )
  ) {
    throw new ResearchStewardError(
      "APPROVAL_TARGET_REQUIRED",
      "Every required approval must name the verification event ID and hash it accepts."
    );
  }
  const targetEventIds = new Set(
    approvalTargets.map((target) => target!.verification_event_id!)
  );
  const targetEventHashes = new Set(
    approvalTargets.map((target) => target!.verification_event_hash!)
  );
  if (targetEventIds.size !== 1 || targetEventHashes.size !== 1) {
    throw new ResearchStewardError(
      "APPROVAL_TARGET_MISMATCH",
      "All required approvals must accept the same deterministic verification event."
    );
  }
  if (!required.some((approval) => approval.authority === actorId)) {
    throw new ResearchStewardError(
      "ACCEPTANCE_AUTHORITY_MISMATCH",
      "The recording actor must match a required approval authority in ACCEPTANCE.yaml."
    );
  }
  const approvalSnapshotHash = sha256Text(
    stableJson(
      required.map((approval) => ({
        id: approval.id ?? "unnamed",
        required: approval.required !== false,
        status: (approval.status ?? "").toLowerCase(),
        authority: approval.authority ?? "",
        accepts: {
          verification_event_id: approval.accepts?.verification_event_id ?? "",
          verification_event_hash: approval.accepts?.verification_event_hash ?? ""
        },
        note: approval.note ?? ""
      }))
    )
  );

  const events = await readEvents(root);
  const targetEventId = [...targetEventIds][0]!;
  const targetEventHash = [...targetEventHashes][0]!;
  const verification = events.find((event) => event.event_id === targetEventId);
  if (!verification) {
    throw new ResearchStewardError(
      "VERIFICATION_REQUIRED",
      "The approval target does not name a committed verification event."
    );
  }
  if (
    verification.type !== "verification" ||
    verification.status !== "complete" ||
    verification.metadata["passed"] !== true ||
    verification.event_hash !== targetEventHash
  ) {
    throw new ResearchStewardError(
      "APPROVAL_TARGET_MISMATCH",
      "The approval target must match the ID and hash of a passing verification event."
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
      "Every blocker must be explicitly resolved and the project re-verified before acceptance."
    );
  }
  const invalidatingEvents = invalidatingEventsAfterVerification(events, verification);
  if (invalidatingEvents.length > 0) {
    throw new ResearchStewardError(
      "VERIFICATION_NOT_CURRENT",
      "The accepted verification must be the latest protocol event; re-verify and update the approval target."
    );
  }

  return appendEvent(root, {
    type: "acceptance",
    actor: { id: actorId, role: "scientific acceptance authority" },
    input_hash: acceptanceDocumentHash,
    depends_on: [verification.event_id],
    summary: note.trim() || "Recorded explicit scientific acceptance.",
    uncertainties: [
      "This event records named human acceptance; it does not turn model consensus into evidence."
    ],
    metadata: {
      verification_event_id: verification.event_id,
      approval_ids: required.map((approval) => approval.id ?? "unnamed"),
      acceptance_document_sha256: acceptanceDocumentHash,
      approval_snapshot_sha256: approvalSnapshotHash
    }
  });
}

export async function recordProvisionalReview(
  root: string,
  actorId: string,
  verificationEventId: string,
  note: string,
  reviewBy = "next human work session"
): Promise<CommittedEvent> {
  const events = await readEvents(root);
  const verification = events.find(
    (event) =>
      event.event_id === verificationEventId &&
      event.type === "verification" &&
      event.status === "complete" &&
      event.metadata["passed"] === true
  );
  if (!verification) {
    throw new ResearchStewardError(
      "VERIFICATION_REQUIRED",
      "Provisional review must target a passing deterministic verification event."
    );
  }
  const invalidatingEvents = invalidatingEventsAfterVerification(events, verification);
  if (invalidatingEvents.length > 0) {
    throw new ResearchStewardError(
      "VERIFICATION_NOT_CURRENT",
      "The provisional review target is no longer current; verify the latest project state first."
    );
  }
  return appendEvent(root, {
    type: "provisional_review",
    actor: { id: actorId, role: "provisional review proxy" },
    depends_on: [verification.event_id],
    summary:
      note.trim() ||
      "Recorded a low-authority provisional review pending named human confirmation.",
    uncertainties: [
      "This provisional review does not establish scientific acceptance and cannot authorize packaging."
    ],
    metadata: {
      verification_event_id: verification.event_id,
      verification_event_hash: verification.event_hash,
      review_by: reviewBy.trim() || "next human work session",
      requires_human_confirmation: true,
      authorizes_acceptance: false,
      authorizes_packaging: false
    }
  });
}

export async function resolveBlocks(
  root: string,
  actorId: string,
  blockedEventIds: readonly string[],
  note: string
): Promise<CommittedEvent> {
  const uniqueEventIds = [...new Set(blockedEventIds)];
  if (uniqueEventIds.length === 0 || uniqueEventIds.length > 512) {
    throw new ResearchStewardError(
      "INVALID_BLOCK_RESOLUTION",
      "Resolve between 1 and 512 explicit blocking event IDs."
    );
  }
  return appendEvent(root, {
    type: "block_resolved",
    actor: { id: actorId, role: "block resolution authority" },
    depends_on: uniqueEventIds,
    summary: note.trim() || "Recorded explicit resolution of named blocking events.",
    metadata: { resolved_event_ids: uniqueEventIds }
  });
}

export async function projectSummary(root: string): Promise<Record<string, unknown>> {
  const [manifest, events] = await Promise.all([readManifest(root), readEvents(root)]);
  const sharedEvents = eventsVisibleInSharedViews(events);
  const unresolvedBlockers = unresolvedBlockedEvents(events).map((event) => ({
    event_id: event.event_id,
    type: event.type,
    actor_id: event.actor.id,
    timestamp: event.timestamp,
    visibility: event.visibility,
    ...(event.run_id ? { run_id: event.run_id } : {})
  }));
  const latestVerification = [...events]
    .reverse()
    .find((event) => event.type === "verification");
  const latestVerificationAccepted = latestVerification
    ? events.some(
      (event) =>
        event.type === "acceptance" &&
        event.status === "complete" &&
        event.depends_on.includes(latestVerification.event_id)
    )
    : false;
  const verificationInvalidators = latestVerification
    ? invalidatingEventsAfterVerification(events, latestVerification)
    : [];
  const humanReview =
    latestVerification?.status === "complete" &&
    latestVerification.metadata["passed"] === true &&
    !latestVerificationAccepted
      ? verificationInvalidators.length === 0
        ? {
          status: "awaiting_human_confirmation",
          verification_event_id: latestVerification.event_id,
          verification_event_hash: latestVerification.event_hash,
          provisional_review_event_ids: events
            .filter(
              (event) =>
                event.type === "provisional_review" &&
                event.depends_on.includes(latestVerification.event_id)
            )
            .map((event) => event.event_id)
          }
        : {
            status: "reverification_required",
            superseded_verification_event_id: latestVerification.event_id,
            invalidating_event_ids: verificationInvalidators.map((event) => event.event_id)
          }
      : null;
  return {
    manifest,
    state: deriveState(events),
    event_count: sharedEvents.length,
    ledger_event_count: events.length,
    latest_event: sharedEvents.at(-1) ?? null,
    unresolved_blockers: unresolvedBlockers,
    attention_required: unresolvedBlockers.length > 0 || humanReview !== null,
    human_review: humanReview
  };
}
