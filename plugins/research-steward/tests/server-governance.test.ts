import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { RootPolicy } from "../src/paths.js";
import { buildServer } from "../src/server.js";
import { appendEvent } from "../src/store.js";
import { initializedProject, temporaryDirectory } from "./helpers.js";

describe("manual MCP adjudication governance", () => {
  it("requires every disclosed report from a blind group", async () => {
    const root = await initializedProject("Manual blind adjudication");
    const first = await appendEvent(root, {
      type: "agent_contribution",
      run_id: "blind-manual",
      actor: { id: "reviewer-a", role: "independent reviewer" },
      visibility: "blind",
      summary: "First blind report.",
      findings: [
        {
          id: "blind-finding-a",
          severity: "medium",
          claim: "A concrete finding from reviewer A.",
          evidence: [],
          uncertainty: "Synthetic test finding.",
          remediation: "Adjudicate against the whole group."
        }
      ],
      metadata: { blind_group: "peer-group" }
    });
    const second = await appendEvent(root, {
      type: "agent_contribution",
      run_id: "blind-manual",
      actor: { id: "reviewer-b", role: "independent reviewer" },
      visibility: "blind",
      summary: "Second blind report.",
      metadata: { blind_group: "peer-group" }
    });
    await appendEvent(root, {
      type: "review_barrier_closed",
      run_id: "blind-manual",
      actor: { id: "research-steward", role: "blind-review-coordinator" },
      depends_on: [first.event_id, second.event_id],
      summary: "Disclosed the complete peer group.",
      metadata: { blind_group: "peer-group" }
    });

    const policy = new RootPolicy();
    await policy.setRoots([root]);
    const server = buildServer(policy);
    const client = new Client({ name: "governance-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const partial = await client.callTool({
        name: "research_adjudicate",
        arguments: {
          project_root: root,
          run_id: "blind-manual",
          actor_id: "manual-adjudicator",
          finding_id: "blind-finding-a",
          disposition: "accept",
          rationale: "This intentionally omits reviewer B.",
          depends_on: [first.event_id]
        }
      });
      expect(partial.isError).toBe(true);
      expect(JSON.stringify(partial.content)).toContain("PARTIAL_BLIND_GROUP_ADJUDICATION");

      const complete = await client.callTool({
        name: "research_adjudicate",
        arguments: {
          project_root: root,
          run_id: "blind-manual",
          actor_id: "manual-adjudicator",
          finding_id: "blind-finding-a",
          disposition: "accept",
          rationale: "Both disclosed peer reports are explicit dependencies.",
          depends_on: [first.event_id, second.event_id]
        }
      });
      expect(complete.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("P1-4 exposes a private blocker ID in status and rejects manual blind turns", async () => {
    const root = await initializedProject("Recoverable private blocker");
    const blocker = await appendEvent(root, {
      type: "blocked",
      actor: { id: "private-reviewer", role: "private reviewer" },
      visibility: "private",
      status: "blocked",
      summary: "Private blocker details remain hidden."
    });
    const policy = new RootPolicy();
    await policy.setRoots([root]);
    const server = buildServer(policy);
    const client = new Client({ name: "status-governance-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const status = await client.callTool({
        name: "research_get_status",
        arguments: { project_root: root }
      });
      expect(status.isError).not.toBe(true);
      expect(JSON.stringify(status.structuredContent)).toContain(blocker.event_id);
      expect(JSON.stringify(status.structuredContent)).not.toContain(
        "Private blocker details remain hidden."
      );

      const blind = await client.callTool({
        name: "research_append_turn",
        arguments: {
          project_root: root,
          run_id: "manual-blind",
          actor_id: "manual-reviewer",
          role: "manual reviewer",
          visibility: "blind",
          status: "complete",
          summary: "This unsupported manual blind turn must be rejected."
        }
      });
      expect(blind.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not return server filesystem paths for unexpected MCP errors", async () => {
    const root = await temporaryDirectory("research-steward-uninitialized-");
    const policy = new RootPolicy();
    await policy.setRoots([root]);
    const server = buildServer(policy);
    const client = new Client({ name: "error-boundary-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const status = await client.callTool({
        name: "research_get_status",
        arguments: { project_root: root }
      });
      const serialized = JSON.stringify(status.content);
      expect(status.isError).toBe(true);
      expect(serialized).toContain("UNEXPECTED_ERROR");
      expect(serialized).toContain("Internal error; see the server log.");
      expect(serialized).not.toContain(root);
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      await client.close();
      await server.close();
    }
  });
});
