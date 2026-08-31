import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpointRaw = process.env.RESEARCH_STEWARD_ENDPOINT;
const token = process.env.RESEARCH_STEWARD_HTTP_TOKEN;
if (!endpointRaw) throw new Error("RESEARCH_STEWARD_ENDPOINT is required");
if (
  !token ||
  token.length > 256 ||
  /(replace|change|example|password|token)/i.test(token) ||
  !(/^[a-fA-F0-9]{64,}$/.test(token) || /^[A-Za-z0-9_-]{43,}$/.test(token))
) {
  throw new Error("RESEARCH_STEWARD_HTTP_TOKEN must be a non-placeholder 256-bit token");
}

const endpoint = new URL(endpointRaw);
if (!endpoint.pathname.match(/\/mcp\/?$/)) {
  throw new Error("RESEARCH_STEWARD_ENDPOINT must end in /mcp");
}
const healthUrl = new URL(endpoint);
healthUrl.pathname = endpoint.pathname.replace(/\/mcp\/?$/, "/healthz");

const health = await fetch(healthUrl);
if (!health.ok) throw new Error(`health check returned ${health.status}`);
const healthBody = await health.json();
if (healthBody?.status !== "ok" || healthBody?.service !== "research-steward") {
  throw new Error("health response did not identify Research Steward");
}

const unauthorized = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}"
});
if (unauthorized.status !== 401) {
  throw new Error(`unauthenticated MCP request returned ${unauthorized.status}, expected 401`);
}

const client = new Client({ name: "research-steward-endpoint-probe", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers: { authorization: `Bearer ${token}` } }
});
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const required = [
    "research_init_project",
    "research_get_status",
    "research_append_turn",
    "research_adjudicate"
  ];
  const names = new Set(listed.tools.map((tool) => tool.name));
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`MCP endpoint is missing required tools: ${missing.join(", ")}`);
  process.stdout.write(
    `${JSON.stringify({ health: "pass", unauthorized: 401, authenticated_mcp: "pass", tools: listed.tools.length }, null, 2)}\n`
  );
} finally {
  await client.close().catch(() => undefined);
}
