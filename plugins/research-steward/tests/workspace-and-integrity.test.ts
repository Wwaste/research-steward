import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  stat,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RootPolicy } from "../src/paths.js";
import {
  appendEvent,
  buildPacketTextBundle,
  freezePacket,
  initializeProject,
  loadPacket,
  projectSummary,
  readEvents,
  resolveBlocks
} from "../src/store.js";
import {
  eventFiles,
  expectErrorCode,
  initializedProject,
  readUtf8,
  temporaryDirectory
} from "./helpers.js";

const actor = { id: "tester", role: "protocol-tester" } as const;

describe("workspace initialization", () => {
  it("is idempotent and never replaces pre-existing non-empty canonical files", async () => {
    const root = await temporaryDirectory();
    const originals: Record<string, string> = {
      "STATUS.md": "# Existing status\n\nOwned by the researcher.\n",
      "TASK.md": "# Existing task\n\nDo not replace this scope.\n",
      "DECISIONS.md": "# Existing decisions\n\nD-001 remains authoritative.\n",
      "ACCEPTANCE.yaml": "version: 1\ncommands: []\nresearcher_note: keep\n",
      "HANDOFF_MANIFEST.yaml": "version: 1\nstatus: researcher-owned\n"
    };
    await Promise.all(
      Object.entries(originals).map(([name, contents]) =>
        writeFile(path.join(root, name), contents, "utf8")
      )
    );

    const first = await initializeProject(root, "Original title");
    const second = await initializeProject(root, "A later title must not replace identity");

    expect(second.manifest).toEqual(first.manifest);
    expect(second.created_files).toEqual([]);
    for (const [name, contents] of Object.entries(originals)) {
      expect(await readUtf8(root, name), name).toBe(contents);
    }
    expect(await readEvents(root)).toHaveLength(1);
  });

  it("preserves researcher-edited task, acceptance, and handoff files on repeat initialization", async () => {
    const root = await initializedProject("Repeat init");
    const edits = {
      "TASK.md": "# Researcher task\n\nFrozen scope.\n",
      "ACCEPTANCE.yaml": "version: 1\ncommands: []\nhuman_approvals: []\n",
      "HANDOFF_MANIFEST.yaml": "version: 1\nstatus: researcher-edited\n"
    };
    await Promise.all(
      Object.entries(edits).map(([name, contents]) => writeFile(path.join(root, name), contents))
    );

    const result = await initializeProject(root, "Ignored replacement title");

    expect(result.created_files).toEqual([]);
    for (const [name, contents] of Object.entries(edits)) {
      expect(await readUtf8(root, name), name).toBe(contents);
    }
  });
});

describe("frozen packets", () => {
  it("copies explicit bytes, records their hash, and detects later frozen-byte tampering", async () => {
    const root = await initializedProject();
    await writeFile(path.join(root, "input.txt"), "alpha\n", "utf8");

    const packet = await freezePacket(root, "packet-one", ["input.txt", "input.txt"]);

    expect(packet.files).toHaveLength(1);
    expect(packet.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await readFile(path.join(root, ".research", "frozen", "packet-one", "files", "input.txt"), "utf8")
    ).toBe("alpha\n");
    await writeFile(path.join(root, "input.txt"), "source changed after freeze\n", "utf8");
    await expect(loadPacket(root, "packet-one")).resolves.toMatchObject({
      packet_hash: packet.packet_hash
    });

    await writeFile(
      path.join(root, ".research", "frozen", "packet-one", "files", "input.txt"),
      "omega\n",
      "utf8"
    );
    await expectErrorCode(loadPacket(root, "packet-one"), "PACKET_FILE_HASH_MISMATCH");
    await writeFile(
      path.join(root, ".research", "frozen", "packet-one", "files", "input.txt"),
      "longer tampered frozen bytes\n",
      "utf8"
    );
    await expectErrorCode(loadPacket(root, "packet-one"), "PACKET_FILE_SIZE_MISMATCH");
  });

  it("does not treat changed source bytes as an idempotent repeat freeze", async () => {
    const root = await initializedProject("Repeat freeze identity");
    await writeFile(path.join(root, "input.txt"), "version one\n", "utf8");
    await freezePacket(root, "stable-id", ["input.txt"]);
    await writeFile(path.join(root, "input.txt"), "version two\n", "utf8");

    await expectErrorCode(
      freezePacket(root, "stable-id", ["input.txt"]),
      "PACKET_INPUT_MISMATCH"
    );
  });

  it("lets exactly one concurrent revision supersede an active packet", async () => {
    const root = await initializedProject("Concurrent packet supersession");
    await writeFile(path.join(root, "input.txt"), "version one\n", "utf8");
    await freezePacket(root, "revision-v1", ["input.txt"]);
    await writeFile(path.join(root, "input.txt"), "version two\n", "utf8");

    const candidateIds = ["revision-v2a", "revision-v2b"];
    const outcomes = await Promise.allSettled(
      candidateIds.map((packetId) =>
        freezePacket(root, packetId, ["input.txt"], ["revision-v1"])
      )
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "PACKET_ALREADY_SUPERSEDED" });

    const successorEvents = (await readEvents(root)).filter(
      (event) =>
        event.type === "packet_frozen" &&
        Array.isArray(event.metadata["supersedes"]) &&
        event.metadata["supersedes"].includes("revision-v1")
    );
    expect(successorEvents).toHaveLength(1);
    const winnerId = successorEvents[0]?.metadata["packet_id"];
    expect(candidateIds).toContain(winnerId);
    const loserId = candidateIds.find((packetId) => packetId !== winnerId)!;
    await expect(stat(path.join(root, ".research", "frozen", loserId))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it.each([".env", ".env.local", "id_ed25519", "credentials.json", "api-token.txt", "server.pem"])(
    "refuses likely credential file %s",
    async (name) => {
      const root = await initializedProject();
      await writeFile(path.join(root, name), "do-not-freeze\n", "utf8");

      await expectErrorCode(freezePacket(root, "sensitive", [name]), "SENSITIVE_FILE");
    }
  );

  it.each([".npmrc", ".netrc", "auth.json", ".ssh/config"])(
    "refuses expanded credential surface %s",
    async (name) => {
      const root = await initializedProject();
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), "do-not-freeze\n", "utf8");
      await expectErrorCode(freezePacket(root, "expanded-sensitive", [name]), "SENSITIVE_FILE");
    }
  );

  it("allows ordinary research names containing credential-like substrings", async () => {
    const root = await initializedProject();
    const names = [
      "tokenizer.py",
      "token_counts.csv",
      "secret_santa.md",
      "credentials_analysis.ipynb",
      "sessions/summary.md"
    ];
    for (const [index, name] of names.entries()) {
      const destination = path.join(root, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, "ordinary research content\n", "utf8");
      await expect(
        freezePacket(root, `ordinary-${index}`, [name])
      ).resolves.toBeTruthy();
    }
  });

  it("rejects a sparse oversized file before copying it into frozen storage", async () => {
    const root = await initializedProject("Oversized frozen input");
    const source = path.join(root, "oversized.bin");
    await writeFile(source, "", "utf8");
    await truncate(source, 512 * 1024 * 1024 + 1);

    await expectErrorCode(
      freezePacket(root, "oversized", ["oversized.bin"]),
      "PACKET_FILE_TOO_LARGE"
    );
    await expect(stat(path.join(root, ".research/frozen/oversized"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("builds a bounded prompt prefix without returning the whole text file", async () => {
    const root = await initializedProject("Bounded packet prompt");
    await writeFile(path.join(root, "large.txt"), "research evidence\n".repeat(20_000), "utf8");
    const packet = await freezePacket(root, "large-text", ["large.txt"]);

    const bundle = await buildPacketTextBundle(root, packet, 2_000);
    expect(bundle.length).toBeLessThanOrEqual(2_000);
    expect(bundle).toContain("truncated by configured prompt limit");
    expect(bundle).not.toContain("research evidence\n".repeat(200));
  });
});

describe("filesystem boundary", () => {
  it("rejects lexical traversal, absolute paths, and symlinks that escape the project", async () => {
    const root = await initializedProject();
    const outside = await temporaryDirectory("research-steward-outside-");
    await writeFile(path.join(outside, "outside.txt"), "outside\n", "utf8");
    await symlink(path.join(outside, "outside.txt"), path.join(root, "escape.txt"));

    await expectErrorCode(freezePacket(root, "traversal", ["../outside.txt"]), "PATH_ESCAPE");
    await expectErrorCode(freezePacket(root, "nested-traversal", ["a/../outside.txt"]), "PATH_ESCAPE");
    await expectErrorCode(freezePacket(root, "dot-path", ["./input.txt"]), "INVALID_PATH");
    await expectErrorCode(freezePacket(root, "double-separator", ["a//input.txt"]), "INVALID_PATH");
    await expectErrorCode(freezePacket(root, "absolute", [path.join(outside, "outside.txt")]), "INVALID_PATH");
    await expectErrorCode(freezePacket(root, "symlink", ["escape.txt"]), "PATH_ESCAPE");

    const policy = new RootPolicy();
    await policy.setRoots([root]);
    await expectErrorCode(policy.resolveProject(outside), "PATH_OUTSIDE_ROOT");
    await expect(policy.resolveProject(root)).resolves.toBe(root);
  });

  it("rejects control characters in artifact paths before archive handling", async () => {
    const root = await initializedProject();
    await expectErrorCode(
      freezePacket(root, "control-character", ["data\nfile.txt"]),
      "INVALID_PATH"
    );
  });
});

describe("append-only event integrity and recovery", () => {
  it("keeps project state blocked until an explicit resolution names the blocker", async () => {
    const root = await initializedProject("Explicit block resolution");
    const blocker = await appendEvent(root, {
      type: "blocked",
      actor,
      status: "blocked",
      summary: "External evidence is missing."
    });
    const laterWork = await appendEvent(root, {
      type: "agent_contribution",
      actor,
      summary: "Work continued, but this does not silently clear the blocker."
    });

    expect((await projectSummary(root)).state).toBe("blocked");
    await expectErrorCode(
      resolveBlocks(root, "resolver", [laterWork.event_id], "Wrong target."),
      "BLOCK_RESOLUTION_TARGET_INVALID"
    );
    const resolution = await resolveBlocks(
      root,
      "resolver",
      [blocker.event_id],
      "The missing evidence was supplied and checked."
    );
    expect(resolution).toMatchObject({
      type: "block_resolved",
      depends_on: [blocker.event_id],
      status: "complete"
    });
    expect((await projectSummary(root)).state).toBe("draft");
    await expectErrorCode(
      resolveBlocks(root, "resolver", [blocker.event_id], "Cannot resolve twice."),
      "BLOCK_RESOLUTION_TARGET_INVALID"
    );
  });

  it("fails loudly when committed event content is edited without its matching hash", async () => {
    const root = await initializedProject();
    await appendEvent(root, {
      type: "agent_contribution",
      actor,
      summary: "original contribution"
    });
    const names = await eventFiles(root);
    const target = path.join(root, ".research", "events", names.at(-1)!);
    const parsed = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
    parsed.summary = "silently rewritten contribution";
    await writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    await expectErrorCode(readEvents(root), "EVENT_HASH_MISMATCH");
  });

  it("fails loudly when deletion creates a gap in the committed sequence", async () => {
    const root = await initializedProject();
    await appendEvent(root, { type: "agent_contribution", actor, summary: "event two" });
    await appendEvent(root, { type: "agent_contribution", actor, summary: "event three" });
    const names = await eventFiles(root);
    await unlink(path.join(root, ".research", "events", names[1]!));

    await expectErrorCode(readEvents(root), "EVENT_SEQUENCE_GAP");
  });

  it("fails loudly when the final event is deleted and the remaining sequence is contiguous", async () => {
    const root = await initializedProject();
    await appendEvent(root, { type: "agent_contribution", actor, summary: "anchored tail" });
    const names = await eventFiles(root);
    await unlink(path.join(root, ".research", "events", names.at(-1)!));

    await expectErrorCode(readEvents(root), "LEDGER_HEAD_MISMATCH");
  });

  it("rejects a dependency that is not already committed", async () => {
    const root = await initializedProject();

    await expectErrorCode(
      appendEvent(root, {
        type: "agent_contribution",
        actor,
        summary: "invalid dependency",
        depends_on: [randomUUID()]
      }),
      "INVALID_EVENT_DEPENDENCY"
    );
    expect(await readEvents(root)).toHaveLength(1);
  });

  it(
    "serializes concurrent writers without losing events or reusing a sequence",
    async () => {
      const root = await initializedProject();
      const count = 40;

      await Promise.all(
        Array.from({ length: count }, (_, index) =>
          appendEvent(root, {
            type: "agent_contribution",
            actor: { id: `writer-${index}`, role: "concurrency-test" },
            summary: `contribution ${index}`
          })
        )
      );

      const events = await readEvents(root);
      expect(events).toHaveLength(count + 1);
      expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length);
      expect(events.map((event) => event.sequence)).toEqual(
        Array.from({ length: count + 1 }, (_, index) => index + 1)
      );
      expect(new Set(events.map((event) => event.event_id)).size).toBe(events.length);
      const rendered = (await readUtf8(root, ".research/rendered/events.jsonl"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event_id: string });
      expect(rendered.map((event) => event.event_id)).toEqual(
        events.map((event) => event.event_id)
      );
    },
    20_000
  );

  it("hides private and unclosed blind events from shared materialized views", async () => {
    const root = await initializedProject("Visibility views");
    const blind = await appendEvent(root, {
      type: "agent_contribution",
      run_id: "visibility-run",
      actor: { id: "blind-reviewer", role: "independent reviewer" },
      visibility: "blind",
      summary: "blind-report-before-barrier",
      metadata: { blind_group: "visibility-group" }
    });
    await appendEvent(root, {
      type: "agent_contribution",
      run_id: "visibility-run",
      actor: { id: "private-reviewer", role: "private reviewer" },
      visibility: "private",
      summary: "private-report-never-shared"
    });

    expect(await readUtf8(root, ".research/rendered/ROUND_TABLE.md")).not.toContain(
      "blind-report-before-barrier"
    );
    expect(await readUtf8(root, ".research/rendered/events.jsonl")).not.toContain(
      "private-report-never-shared"
    );

    await appendEvent(root, {
      type: "review_barrier_closed",
      run_id: "visibility-run",
      actor: { id: "research-steward", role: "blind-review-coordinator" },
      depends_on: [blind.event_id],
      summary: "visibility barrier closed",
      metadata: { blind_group: "visibility-group" }
    });

    const roundTable = await readUtf8(root, ".research/rendered/ROUND_TABLE.md");
    const sharedEvents = await readUtf8(root, ".research/rendered/events.jsonl");
    expect(roundTable).toContain("blind-report-before-barrier");
    expect(roundTable).not.toContain("private-report-never-shared");
    expect(sharedEvents).toContain("blind-report-before-barrier");
    expect(sharedEvents).not.toContain("private-report-never-shared");
  });

  it("P1-5 atomically reclaims an abandoned stale event lock", async () => {
    const root = await initializedProject();
    const eventsDirectory = path.join(root, ".research", "events");
    const orphan = path.join(eventsDirectory, `.00000002-${randomUUID()}.json.999.tmp`);
    await writeFile(orphan, "{not complete json", "utf8");

    const lock = path.join(root, ".research", ".event-lock");
    await mkdir(lock, { mode: 0o700 });
    await writeFile(
      path.join(lock, "owner.json"),
      `${JSON.stringify({
        owner_token: "00000000-0000-4000-8000-000000000002",
        pid: 999999,
        acquired_at: "2000-01-01T00:00:00.000Z"
      })}\n`,
      "utf8"
    );
    const stale = new Date(Date.now() - 180_000);
    await utimes(lock, stale, stale);

    const writerCount = 16;
    const committed = await Promise.all(
      Array.from({ length: writerCount }, (_, index) =>
        appendEvent(root, {
          type: "agent_contribution",
          actor: { id: `stale-lock-${index}`, role: "concurrency-test" },
          summary: `writer ${index} recovered after abandoned writer`
        })
      )
    );

    expect(committed.map((event) => event.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: writerCount }, (_, index) => index + 2)
    );
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    const events = await readEvents(root);
    expect(events).toHaveLength(writerCount + 1);
    expect(new Set(events.map((event) => event.sequence)).size).toBe(writerCount + 1);
    await expect(readFile(orphan, "utf8")).resolves.toBe("{not complete json");
  });
});
