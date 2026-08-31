import { readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isStrongHttpToken } from "../src/server.js";
import { appendEvent, loadPacket, readEvents } from "../src/store.js";
import { sha256Text, stableJson } from "../src/utils.js";
import { expectErrorCode, initializedProject, temporaryDirectory } from "./helpers.js";

const actor = { id: "security-test", role: "security tester" } as const;

describe("protocol security boundaries", () => {
  it("rejects an oversized event before commit and leaves the ledger usable", async () => {
    const root = await initializedProject("Bounded event ledger");

    await expectErrorCode(
      appendEvent(root, {
        type: "agent_contribution",
        actor,
        summary: "s".repeat(100_000),
        uncertainties: Array.from({ length: 100 }, () => "u".repeat(2_000))
      }),
      "EVENT_TOO_LARGE"
    );
    expect(await readEvents(root)).toHaveLength(1);

    await appendEvent(root, {
      type: "agent_contribution",
      actor,
      summary: "The rejected event did not poison the ledger."
    });
    expect(await readEvents(root)).toHaveLength(2);
  });

  it("treats render failure as repairable derived-state failure after event commit", async () => {
    const root = await initializedProject("Repairable materialized views");
    const rendered = path.join(root, ".research", "rendered");
    await rm(rendered, { recursive: true });
    await writeFile(rendered, "blocks view rendering\n", "utf8");

    const committed = await appendEvent(root, {
      type: "agent_contribution",
      actor,
      summary: "Authoritative event survives a broken rendered directory."
    });

    expect(committed.sequence).toBe(2);
    expect((await readEvents(root)).at(-1)?.event_id).toBe(committed.event_id);
  });

  it("rejects a symlink substituted for the protected event directory", async () => {
    const root = await initializedProject("Protected internal tree");
    const outside = await temporaryDirectory("research-steward-symlink-target-");
    await rename(
      path.join(root, ".research", "events"),
      path.join(root, ".research", "events-original")
    );
    await symlink(outside, path.join(root, ".research", "events"));

    await expectErrorCode(readEvents(root), "SYMLINK_COMPONENT");
  });

  it("does not follow or echo an out-of-root acceptance symlink during verification", async () => {
    const root = await initializedProject("Acceptance symlink boundary");
    const outside = await temporaryDirectory("research-steward-private-yaml-");
    const privateMarker = "PRIVATE_MARKER_MUST_NOT_BE_READ";
    const outsideAcceptance = path.join(outside, "acceptance.yaml");
    await writeFile(outsideAcceptance, `invalid: [${privateMarker}\n`, "utf8");
    await rm(path.join(root, "ACCEPTANCE.yaml"));
    await symlink(outsideAcceptance, path.join(root, "ACCEPTANCE.yaml"));

    const { verifyProject } = await import("../src/store.js");
    const report = await verifyProject(root);
    const serialized = JSON.stringify(report);
    expect(report.passed).toBe(false);
    expect(serialized).not.toContain(privateMarker);
    expect(serialized).not.toContain(outsideAcceptance);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "acceptance:syntax",
        status: "fail",
        message: "Acceptance document could not be resolved and parsed safely."
      })
    );
  });

  it("rejects duplicate decisions for the same upstream finding", async () => {
    const root = await initializedProject("Unique adjudication decisions");
    const contribution = await appendEvent(root, {
      type: "agent_contribution",
      actor,
      summary: "One independently reviewable finding.",
      findings: [
        {
          id: "one-finding",
          severity: "medium",
          claim: "A single finding must not receive contradictory duplicate decisions.",
          evidence: [],
          uncertainty: "Synthetic governance test.",
          remediation: "Commit one disposition per upstream finding."
        }
      ]
    });

    await expectErrorCode(
      appendEvent(root, {
        type: "adjudication",
        actor: { id: "adjudicator", role: "evidence adjudicator" },
        depends_on: [contribution.event_id],
        summary: "An invalid duplicate adjudication.",
        decisions: [
          {
            finding_id: "one-finding",
            disposition: "accept",
            rationale: "First disposition."
          },
          {
            finding_id: "one-finding",
            disposition: "reject",
            rationale: "Contradictory duplicate disposition."
          }
        ]
      }),
      "DUPLICATE_ADJUDICATION"
    );
  });

  it("rejects a hash-consistent frozen manifest whose file path traverses outward", async () => {
    const root = await initializedProject("Untrusted packet manifest");
    await writeFile(path.join(root, "evidence.md"), "evidence\n", "utf8");
    const { freezePacket } = await import("../src/store.js");
    await freezePacket(root, "safe-packet", ["evidence.md"]);
    const manifestPath = path.join(
      root,
      ".research",
      "frozen",
      "safe-packet",
      "manifest.json"
    );
    const packet = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    packet.files[0].path = "../outside.txt";
    const { packet_hash: _discarded, ...withoutHash } = packet;
    packet.packet_hash = sha256Text(stableJson(withoutHash));
    await writeFile(manifestPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");

    await expectErrorCode(loadPacket(root, "safe-packet"), "PATH_ESCAPE");
  });

  it("rejects documented placeholders while accepting a generated 256-bit token", () => {
    expect(isStrongHttpToken("replace-with-at-least-32-random-characters")).toBe(false);
    expect(isStrongHttpToken("short-secret")).toBe(false);
    expect(isStrongHttpToken("0123456789abcdef".repeat(4))).toBe(true);
  });
});
