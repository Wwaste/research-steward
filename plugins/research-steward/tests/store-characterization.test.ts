import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendEvent,
  freezePacket,
  initializeProject,
  readEvents,
  verifyProject
} from "../src/store.js";
import { initializedProject, temporaryDirectory } from "./helpers.js";

/**
 * Characterization locks for store.ts before any future split (Task 5.7).
 * These assertions freeze today's public behavior; a refactor that breaks
 * them must update this file in the same commit.
 */
describe("store characterization (Task 5.7 prep)", () => {
  it("initializeProject creates manifest + head and one event", async () => {
    const root = await temporaryDirectory();
    await initializeProject(root, "Characterization");
    const events = await readEvents(root);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe("project_initialized");
  });

  it("freeze + verify round-trip passes on a tiny packet", async () => {
    const root = await initializedProject("Characterization packet");
    await writeFile(path.join(root, "a.md"), "x\n", "utf8");
    await freezePacket(root, "pkt", ["a.md"]);
    const report = await verifyProject(root);
    expect(report.passed).toBe(true);
  });

  it("appendEvent extends the hash chain", async () => {
    const root = await initializedProject("Characterization append");
    const before = await readEvents(root);
    await appendEvent(root, {
      type: "candidate_declared",
      actor: { id: "char", role: "author" },
      summary: "characterization"
    });
    const after = await readEvents(root);
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)!.previous_event_hash).toBe(before.at(-1)!.event_hash);
  });
});
