import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { RootPolicy } from "../src/paths.js";
import { buildServer } from "../src/server.js";
import { initializedProject } from "./helpers.js";

async function connectedClient(root: string): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const policy = new RootPolicy();
  await policy.setRoots([root]);
  const server = buildServer(policy);
  const client = new Client({ name: "wiring-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

function firstJson(result: unknown): unknown {
  const content = (result as { content?: Array<Record<string, unknown>> }).content ?? [];
  const text = content.find((item) => item["type"] === "text")?.["text"];
  expect(typeof text, "tool returned no text content").toBe("string");
  return JSON.parse(text as string);
}

describe("phase 1 wiring (doctor, build-plan, dry-run)", () => {
  it("advertises exactly 16 MCP tools including the three new ones", async () => {
    const root = await initializedProject("Wiring inventory");
    const { client, close } = await connectedClient(root);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(tools.tools).toHaveLength(16);
      expect(names).toEqual(
        expect.arrayContaining(["research_doctor", "research_build_plan", "research_dry_run"])
      );
    } finally {
      await close();
    }
  });

  it("returns a schema-valid doctor report over MCP without touching providers", async () => {
    const root = await initializedProject("Wiring doctor");
    const { client, close } = await connectedClient(root);
    try {
      const result = await client.callTool({
        name: "research_doctor",
        arguments: { project_root: root }
      });
      expect(result.isError).not.toBe(true);
      const report = firstJson(result) as {
        overall: string;
        checks: Array<{ id: string; status: string }>;
      };
      expect(["pass", "warn", "fail"]).toContain(report.overall);
      const ids = report.checks.map((check) => check.id);
      expect(ids).toEqual(
        expect.arrayContaining(["node.version", "bundle.dist", "project.root", "http.token"])
      );
      const auth = report.checks.filter((check) => check.id.endsWith(".auth"));
      expect(auth.length).toBeGreaterThan(0);
      for (const check of auth) expect(check.status).toBe("skipped");
    } finally {
      await close();
    }
  });

  it("previews a plan without writing, and write=true lands both files exactly once", async () => {
    const root = await initializedProject("Wiring build-plan");
    const { client, close } = await connectedClient(root);
    try {
      const preview = await client.callTool({
        name: "research_build_plan",
        arguments: { preset_id: "quick-review", packet_id: "wiring-packet" }
      });
      expect(preview.isError).not.toBe(true);
      const previewed = firstJson(preview) as {
        plan: { packet_id: string };
        lock: { plan_hash: string };
        written: boolean;
      };
      expect(previewed.written).toBe(false);
      expect(previewed.plan.packet_id).toBe("wiring-packet");
      expect(previewed.lock.plan_hash).toMatch(/^[a-f0-9]{64}$/);

      const missingPaths = await client.callTool({
        name: "research_build_plan",
        arguments: { preset_id: "quick-review", packet_id: "wiring-packet", write: true }
      });
      expect(missingPaths.isError).toBe(true);
      expect(JSON.stringify(missingPaths.content)).toContain("PLAN_WRITE_REQUIRES_PROJECT");

      const written = await client.callTool({
        name: "research_build_plan",
        arguments: {
          preset_id: "quick-review",
          packet_id: "wiring-packet",
          write: true,
          project_root: root,
          plan_path: "quick.plan.json",
          lock_path: "quick.lock.json"
        }
      });
      expect(written.isError).not.toBe(true);
      const landed = JSON.parse(
        await readFile(path.join(root, "quick.plan.json"), "utf8")
      ) as { packet_id: string };
      expect(landed.packet_id).toBe("wiring-packet");

      const clobber = await client.callTool({
        name: "research_build_plan",
        arguments: {
          preset_id: "quick-review",
          packet_id: "wiring-packet",
          write: true,
          project_root: root,
          plan_path: "quick.plan.json",
          lock_path: "quick.lock.json"
        }
      });
      expect(clobber.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("computes a dry-run forecast over MCP and rejects an invalid plan", async () => {
    const root = await initializedProject("Wiring dry-run");
    const { client, close } = await connectedClient(root);
    try {
      const plan = {
        version: 1,
        name: "wiring forecast",
        packet_id: "wiring-packet",
        mode: "open",
        limits: {
          max_parallel: 2,
          max_wall_time_ms: 60_000,
          max_prompt_chars: 10_000,
          max_output_chars: 5_000,
          retry_limit: 1,
          max_failures: 1
        },
        nodes: [
          {
            id: "solo",
            actor_id: "solo",
            role: "reviewer",
            adapter: "fake",
            brief: "review the packet",
            depends_on: [],
            visibility: "shared",
            can_adjudicate: false,
            timeout_ms: 30_000
          }
        ]
      };
      const result = await client.callTool({
        name: "research_dry_run",
        arguments: { plan }
      });
      expect(result.isError).not.toBe(true);
      const forecast = firstJson(result) as {
        node_count: number;
        fake_invocations: number;
        worst_case_invocations: number;
      };
      expect(forecast.node_count).toBe(1);
      expect(forecast.worst_case_invocations).toBe(0);
      expect(forecast.fake_invocations).toBe(2);

      const invalid = await client.callTool({
        name: "research_dry_run",
        arguments: { plan: { version: 2 } }
      });
      expect(invalid.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
