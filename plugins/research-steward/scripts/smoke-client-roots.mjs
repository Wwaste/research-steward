import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "research-steward-client-roots-"));
const env = { ...process.env };
delete env.RESEARCH_STEWARD_ROOTS;

const client = new Client(
  { name: "research-steward-client-roots-smoke", version: "1.0.0" },
  { capabilities: { roots: {} } }
);
client.setRequestHandler(ListRootsRequestSchema, async () => ({
  roots: [{ uri: pathToFileURL(root).href, name: "smoke-root" }]
}));
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/server.mjs"],
  env
});

try {
  await client.connect(transport);
  const initialized = await client.callTool({
    name: "research_init_project",
    arguments: { project_root: root, title: "Client roots smoke project" }
  });
  if (initialized.isError) {
    const detail = initialized.content.find((item) => item.type === "text")?.text;
    throw new Error(`research_init_project rejected client roots: ${detail ?? "unknown error"}`);
  }
  const status = await client.callTool({
    name: "research_get_status",
    arguments: { project_root: root }
  });
  if (status.isError) throw new Error("research_get_status rejected a client-granted root");
  const tools = await client.listTools();
  process.stdout.write(
    `${JSON.stringify(
      {
        environment_root_absent: !("RESEARCH_STEWARD_ROOTS" in env),
        client_roots: "pass",
        init: "pass",
        status: "pass",
        tools: tools.tools.length
      },
      null,
      2
    )}\n`
  );
} finally {
  await client.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
