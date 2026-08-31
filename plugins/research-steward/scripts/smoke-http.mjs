import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not allocate port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const root = await mkdtemp(path.join(os.tmpdir(), "research-steward-http-smoke-"));
const port = await freePort();
const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const child = spawn("node", ["dist/server.mjs", "--http"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RESEARCH_STEWARD_ROOTS: root,
    RESEARCH_STEWARD_HTTP_TOKEN: token,
    RESEARCH_STEWARD_HTTP_HOST: "127.0.0.1",
    RESEARCH_STEWARD_HTTP_PORT: String(port),
    RESEARCH_STEWARD_ALLOWED_HOSTS: "127.0.0.1",
    RESEARCH_STEWARD_ALLOWED_ORIGINS: "https://allowed.example"
  },
  stdio: ["ignore", "ignore", "pipe"]
});

async function waitReady() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("HTTP server readiness timeout")), 10000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`HTTP server exited early with ${String(code)}`));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (chunk.includes("listening on")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

try {
  await waitReady();
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/healthz`);
  if (!health.ok) throw new Error("health check failed");
  const healthBody = await health.json();
  if (
    healthBody?.status !== "ok" ||
    healthBody?.service !== "research-steward" ||
    healthBody?.mcp_server !== "research-steward-mcp-server"
  ) {
    throw new Error("health check returned the wrong service identity");
  }

  const unauthorized = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  if (unauthorized.status !== 401) throw new Error(`expected 401, got ${unauthorized.status}`);

  const badOrigin = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      origin: "https://blocked.example"
    },
    body: "{}"
  });
  if (badOrigin.status !== 403) throw new Error(`expected 403, got ${badOrigin.status}`);

  const preflight = await fetch(`${base}/mcp`, {
    method: "OPTIONS",
    headers: {
      origin: "https://allowed.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type,mcp-protocol-version"
    }
  });
  if (preflight.status !== 204) throw new Error(`expected preflight 204, got ${preflight.status}`);
  if (preflight.headers.get("access-control-allow-origin") !== "https://allowed.example") {
    throw new Error("allowed CORS origin was not echoed on preflight");
  }

  const client = new Client({ name: "research-steward-http-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === "research_get_status")) {
      throw new Error("HTTP MCP did not advertise expected tools");
    }
    process.stdout.write(
      `${JSON.stringify({ health: "pass", unauthorized: 401, bad_origin: 403, preflight: 204, mcp_tools: tools.tools.length }, null, 2)}\n`
    );
  } finally {
    await client.close().catch(() => undefined);
  }
} finally {
  child.kill("SIGTERM");
  await rm(root, { recursive: true, force: true });
}
