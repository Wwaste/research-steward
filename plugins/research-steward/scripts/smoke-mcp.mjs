import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = await mkdtemp(path.join(os.tmpdir(), "research-steward-mcp-smoke-"));
const client = new Client({ name: "research-steward-smoke-client", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/server.mjs"],
  env: {
    ...process.env,
    RESEARCH_STEWARD_ROOTS: root
  }
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === "research_init_project")) {
    throw new Error("research_init_project was not advertised");
  }
  const initialized = await client.callTool({
    name: "research_init_project",
    arguments: {
      project_root: root,
      title: "MCP smoke project"
    }
  });
  if (initialized.isError) {
    throw new Error("research_init_project returned an MCP tool error");
  }
  const status = await client.callTool({
    name: "research_get_status",
    arguments: { project_root: root }
  });
  if (status.isError) {
    throw new Error("research_get_status returned an MCP tool error");
  }

  const contribution = await client.callTool({
    name: "research_append_turn",
    arguments: {
      project_root: root,
      actor_id: "smoke-reviewer",
      role: "reviewer",
      summary: "Structured smoke finding.",
      findings: [
        {
          id: "smoke-finding",
          severity: "low",
          claim: "A finding needs an evidence-linked adjudication.",
          evidence: [],
          uncertainty: "Synthetic smoke finding.",
          remediation: "Adjudicate through a committed dependency."
        }
      ]
    }
  });
  if (contribution.isError) throw new Error("research_append_turn returned an MCP tool error");
  const contributionText = contribution.content.find((item) => item.type === "text")?.text;
  if (!contributionText) throw new Error("research_append_turn returned no JSON text");
  const contributionEvent = JSON.parse(contributionText);

  const adjudication = await client.callTool({
    name: "research_adjudicate",
    arguments: {
      project_root: root,
      actor_id: "smoke-adjudicator",
      finding_id: "smoke-finding",
      disposition: "accept",
      rationale: "The smoke finding exists in the named committed event.",
      depends_on: [contributionEvent.event_id]
    }
  });
  if (adjudication.isError) throw new Error("research_adjudicate returned an MCP tool error");
  process.stdout.write(
    `${JSON.stringify({ tools: tools.tools.length, init: "pass", status: "pass", evidence_linked_adjudication: "pass" }, null, 2)}\n`
  );
} finally {
  await client.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
