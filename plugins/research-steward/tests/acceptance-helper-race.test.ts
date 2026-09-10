import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

// The race is driven from inside readEvents rather than from a timer: the
// helper reads ACCEPTANCE.yaml, then awaits the ledger, then writes, so the
// mutation below lands in exactly the window a human edit would.
const ledgerRace = vi.hoisted(() => ({
  duringReadEvents: null as null | (() => Promise<void>)
}));

vi.mock("../src/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store.js")>();
  return {
    ...actual,
    readEvents: async (root: string) => {
      const race = ledgerRace.duringReadEvents;
      if (race) {
        ledgerRace.duringReadEvents = null;
        await race();
      }
      return actual.readEvents(root);
    }
  };
});

import { prepareAcceptance } from "../src/acceptance-helper.js";
import type { VerificationReport } from "../src/protocol.js";
import { freezePacket, verifyProject } from "../src/store.js";
import { expectErrorCode, initializedProject, readUtf8 } from "./helpers.js";

interface ParsedAcceptance {
  human_approvals: Array<{
    id?: string;
    status?: string;
    authority?: string;
    note?: string;
    accepts?: { verification_event_id?: string; verification_event_hash?: string };
  }>;
}

const HUMAN_EDITED = `version: 1
commands: []
human_approvals:
  - id: scientific-acceptance
    required: true
    status: approved
    authority: human-reviewer
    accepts:
      verification_event_id: ""
      verification_event_hash: ""
    note: human wrote this during ledger check
`;

const TWO_APPROVALS = `version: 1
commands: []
human_approvals:
  - id: lead
    required: true
    status: pending
    authority: ""
    accepts:
      verification_event_id: ""
      verification_event_hash: ""
  - id: reviewer
    required: true
    status: pending
    authority: ""
    accepts:
      verification_event_id: ""
      verification_event_hash: ""
`;

const REVIEWER_ONLY = `version: 1
commands: []
human_approvals:
  - id: reviewer
    required: true
    status: approved
    authority: human-reviewer
    accepts:
      verification_event_id: ""
      verification_event_hash: ""
    note: human wrote this during ledger check
`;

async function verifiedProject(
  title = "Acceptance helper race test"
): Promise<{ root: string; report: VerificationReport }> {
  const root = await initializedProject(title);
  await writeFile(path.join(root, "analysis.md"), "candidate result\n", "utf8");
  await freezePacket(root, "candidate", ["analysis.md"]);
  const report = await verifyProject(root);
  expect(report.passed).toBe(true);
  return { root, report };
}

function raceWrite(root: string, contents: string): () => Promise<void> {
  return async () => {
    await writeFile(path.join(root, "ACCEPTANCE.yaml"), contents, "utf8");
  };
}

async function approvals(root: string): Promise<ParsedAcceptance["human_approvals"]> {
  return (parseYaml(await readUtf8(root, "ACCEPTANCE.yaml")) as ParsedAcceptance).human_approvals;
}

afterEach(() => {
  ledgerRace.duringReadEvents = null;
});

describe("prepareAcceptance concurrent-edit safety (RS-V1-SUP-014)", () => {
  it("refuses to write when a human edits status, authority and note during the ledger checks", async () => {
    const { root } = await verifiedProject();
    ledgerRace.duringReadEvents = raceWrite(root, HUMAN_EDITED);

    await expectErrorCode(prepareAcceptance(root, {}), "ACCEPTANCE_DOCUMENT_CHANGED");

    expect(await readUtf8(root, "ACCEPTANCE.yaml")).toBe(HUMAN_EDITED);
  });

  it("refuses to write when a human removes an approval entry and shifts the remaining indexes", async () => {
    const { root } = await verifiedProject();
    await writeFile(path.join(root, "ACCEPTANCE.yaml"), TWO_APPROVALS, "utf8");
    ledgerRace.duringReadEvents = raceWrite(root, REVIEWER_ONLY);

    await expectErrorCode(
      prepareAcceptance(root, { approvalId: "reviewer" }),
      "ACCEPTANCE_DOCUMENT_CHANGED"
    );

    expect(await readUtf8(root, "ACCEPTANCE.yaml")).toBe(REVIEWER_ONLY);
  });

  it("still fills the accepts block when nothing changes during the ledger checks", async () => {
    const { root, report } = await verifiedProject();

    const result = await prepareAcceptance(root, {});

    expect(result).toEqual({
      approval_id: "scientific-acceptance",
      verification_event_id: report.verification_event_id,
      verification_event_hash: report.verification_event_hash,
      changed: true
    });
    expect((await approvals(root))[0]!.accepts).toEqual({
      verification_event_id: report.verification_event_id,
      verification_event_hash: report.verification_event_hash
    });
  });

  it("lets a fresh run fill accepts on top of the human edits it refused to overwrite", async () => {
    const { root, report } = await verifiedProject();
    ledgerRace.duringReadEvents = raceWrite(root, HUMAN_EDITED);
    await expectErrorCode(prepareAcceptance(root, {}), "ACCEPTANCE_DOCUMENT_CHANGED");

    const result = await prepareAcceptance(root, {});

    expect(result.changed).toBe(true);
    const approval = (await approvals(root))[0]!;
    expect(approval.status).toBe("approved");
    expect(approval.authority).toBe("human-reviewer");
    expect(approval.note).toBe("human wrote this during ledger check");
    expect(approval.accepts).toEqual({
      verification_event_id: report.verification_event_id,
      verification_event_hash: report.verification_event_hash
    });
  });
});
