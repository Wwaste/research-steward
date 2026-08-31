import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { RootPolicy } from "./paths.js";
import {
  appendEvent,
  freezePacket,
  initializeProject,
  projectSummary,
  recordAcceptance,
  recordProvisionalReview,
  readEvents,
  readSharedEvents,
  renderViews,
  resolveBlocks,
  verifyProject
} from "./store.js";
import { runRoundtable } from "./workflow.js";
import { packageHandoff } from "./package.js";
import { EvidenceSchema, FindingSchema } from "./protocol.js";
import { ResearchStewardError, errorMessage } from "./utils.js";

const SERVER_NAME = "research-steward-mcp-server";
const SERVER_VERSION = "0.1.0";
const HEALTH_SERVICE_NAME = "research-steward";

function jsonResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const structured =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : { value };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: structured
  };
}

function toolError(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  const code = error instanceof ResearchStewardError ? error.code : "UNEXPECTED_ERROR";
  const message =
    error instanceof ResearchStewardError
      ? errorMessage(error)
      : "Internal error; see the server log.";
  if (!(error instanceof ResearchStewardError)) {
    process.stderr.write(`[research-steward] unexpected tool error: ${errorMessage(error)}\n`);
  }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: code, message }) }]
  };
}

async function withProject<T>(
  policy: RootPolicy,
  rawRoot: string,
  operation: (root: string) => Promise<T>
): Promise<ReturnType<typeof jsonResult> | ReturnType<typeof toolError>> {
  try {
    const root = await policy.resolveProject(rawRoot);
    return jsonResult(await operation(root));
  } catch (error) {
    return toolError(error);
  }
}

export function buildServer(policy: RootPolicy): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { logging: {}, resources: {} } }
  );

  server.registerTool(
    "research_init_project",
    {
      title: "Initialize Research Project",
      description:
        "Idempotently create the five canonical research files and .research machine state inside an allowed project root. Existing non-empty canonical files are preserved.",
      inputSchema: {
        project_root: z.string().min(1).max(4_096),
        title: z.string().min(1).max(200)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_root, title }) =>
      withProject(policy, project_root, (root) => initializeProject(root, title))
  );

  server.registerTool(
    "research_freeze_packet",
    {
      title: "Freeze Research Packet",
      description:
        "Copy explicit project-relative files into an immutable content-addressed review packet, record SHA-256 values, and append a packet_frozen event. Likely credential files are rejected.",
      inputSchema: {
        project_root: z.string().min(1).max(4_096),
        packet_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        files: z.array(z.string().min(1).max(4_096)).min(1).max(500),
        supersedes: z
          .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
          .max(500)
          .default([])
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_root, packet_id, files, supersedes }) =>
      withProject(policy, project_root, (root) =>
        freezePacket(root, packet_id, files, supersedes)
      )
  );

  server.registerTool(
    "research_append_turn",
    {
      title: "Append Attributable Research Turn",
      description:
        "Atomically commit one attributable, immutable shared or private contribution. Manual blind turns are rejected because they lack a participant roster and closable barrier; use research_run_roundtable for blind review. Visibility is routing, not confidentiality from the shared bearer or OS account.",
      inputSchema: {
        project_root: z.string().min(1).max(4_096),
        run_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/).optional(),
        actor_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
        role: z.string().min(1).max(100),
        adapter: z.string().min(1).max(50).optional(),
        model: z.string().min(1).max(100).optional(),
        input_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        depends_on: z.array(z.string().uuid()).max(512).default([]),
        visibility: z.enum(["shared", "private"]).default("shared"),
        status: z.enum(["complete", "blocked", "failed"]).default("complete"),
        summary: z.string().max(100_000),
        uncertainties: z.array(z.string().max(2_000)).max(100).default([]),
        evidence: z.array(EvidenceSchema).max(200).default([]),
        findings: z.array(FindingSchema).max(200).default([])
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) =>
      withProject(policy, input.project_root, (root) =>
        appendEvent(root, {
          type: input.status === "blocked" ? "blocked" : "agent_contribution",
          ...(input.run_id ? { run_id: input.run_id } : {}),
          actor: {
            id: input.actor_id,
            role: input.role,
            ...(input.adapter ? { adapter: input.adapter } : {}),
            ...(input.model ? { model: input.model } : {})
          },
          ...(input.input_hash ? { input_hash: input.input_hash } : {}),
          depends_on: input.depends_on,
          visibility: input.visibility,
          status: input.status,
          summary: input.summary,
          uncertainties: input.uncertainties,
          evidence: input.evidence,
          findings: input.findings
        })
      )
  );

  server.registerTool(
    "research_list_events",
    {
      title: "List Research Events",
      description:
        "Read validated immutable events with bounded pagination. Hash or schema failures are reported loudly instead of returning a partial trusted history.",
      inputSchema: {
        project_root: z.string().min(1).max(4_096),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_root, offset, limit }) =>
      withProject(policy, project_root, async (root) => {
        const events = await readSharedEvents(root);
        const items = events.slice(offset, offset + limit);
        return {
          total_count: events.length,
          count: items.length,
          offset,
          has_more: offset + items.length < events.length,
          next_offset: offset + items.length < events.length ? offset + items.length : null,
          events: items
        };
      })
  );

  server.registerTool(
    "research_get_status",
    {
      title: "Get Research Project Status",
      description: "Return machine-derived state, project identity, event counts, the latest shared event, and minimal IDs for every unresolved blocker including private blockers.",
      inputSchema: { project_root: z.string().min(1).max(4_096) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_root }) =>
      withProject(policy, project_root, (root) => projectSummary(root))
  );

  server.registerTool(
    "research_render_views",
    {
      title: "Render Research Views",
      description:
        "Regenerate STATUS.md, DECISIONS.md, events.jsonl, and ROUND_TABLE.md from immutable events. Derived views never override the event authority.",
      inputSchema: { project_root: z.string().min(1).max(4_096) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_root }) =>
      withProject(policy, project_root, async (root) => {
        await renderViews(root);
        return { rendered: true };
      })
  );

  server.registerTool(
    "research_run_roundtable",
    {
      title: "Run Research Round Table",
      description:
        "Execute or resume a bounded DAG of Kimi, Qoder, Grok, or test nodes against one frozen packet. Dependencies trigger automatically, blind-group peers cannot read one another, and every terminal result becomes an immutable event.",
      inputSchema: {
        project_root: z.string().min(1).max(4_096),
        plan: z.unknown(),
        run_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ project_root, plan, run_id }) =>
      withProject(policy, project_root, (root) => runRoundtable(root, plan, run_id))
  );

  server.registerTool(
    "research_adjudicate",
    {
      title: "Record Evidence Adjudication",
      description:
        "Append an evidence-weighted disposition for one frozen finding. Dispositions are accept, partial, reject, or defer; they do not modify scientific artifacts.",
      inputSchema: {
        project_root: z.string().min(1).max(4_096),
        run_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/).optional(),
        actor_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
        finding_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
        disposition: z.enum(["accept", "partial", "reject", "defer"]),
        rationale: z.string().min(1).max(20_000),
        action: z.string().max(10_000).default(""),
        owner: z.string().max(100).default(""),
        change_evidence: z.string().max(10_000).default(""),
        depends_on: z.array(z.string().uuid()).min(1).max(64)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) =>
      withProject(policy, input.project_root, async (root) => {
        const events = await readEvents(root);
        const eventById = new Map(events.map((event) => [event.event_id, event]));
        const dependencies = input.depends_on.map((eventId) => eventById.get(eventId));
        if (dependencies.some((event) => event === undefined)) {
          throw new ResearchStewardError(
            "UNKNOWN_ADJUDICATION_DEPENDENCY",
            "Every adjudication dependency must name an existing committed event."
          );
        }
        const committedDependencies = dependencies.filter(
          (event): event is NonNullable<typeof event> => event !== undefined
        );
        if (committedDependencies.some((event) => event.status !== "complete")) {
          throw new ResearchStewardError(
            "INCOMPLETE_ADJUDICATION_DEPENDENCY",
            "Adjudication dependencies must all be complete."
          );
        }
        const matchingFindings = committedDependencies.flatMap((event) =>
          event.findings.filter((finding) => finding.id === input.finding_id)
        );
        if (matchingFindings.length !== 1) {
          throw new ResearchStewardError(
            "FINDING_NOT_IN_DEPENDENCIES",
            "The adjudicated finding must exist exactly once across the named dependencies."
          );
        }
        if (
          input.run_id &&
          committedDependencies.some((event) => event.run_id !== input.run_id)
        ) {
          throw new ResearchStewardError(
            "ADJUDICATION_RUN_MISMATCH",
            "Every adjudication dependency must belong to the requested run."
          );
        }
        const blindGroups = new Set(
          committedDependencies
            .filter((event) => event.visibility === "blind")
            .map((event) => event.metadata["blind_group"])
            .filter((group): group is string => typeof group === "string")
        );
        if (blindGroups.size > 0 && !input.run_id) {
          throw new ResearchStewardError(
            "BLIND_ADJUDICATION_RUN_REQUIRED",
            "Adjudicating a blind finding requires its run ID and a closed barrier."
          );
        }
        for (const group of blindGroups) {
          const barrier = events.find(
            (event) =>
              event.type === "review_barrier_closed" &&
              event.run_id === input.run_id &&
              event.metadata["blind_group"] === group &&
              event.status === "complete"
          );
          if (!barrier) {
            throw new ResearchStewardError(
              "BLIND_BARRIER_OPEN",
              `Blind group ${group} has no complete disclosure barrier.`
            );
          }
          const missingGroupDependencies = barrier.depends_on.filter(
            (eventId) => !input.depends_on.includes(eventId)
          );
          if (missingGroupDependencies.length > 0) {
            throw new ResearchStewardError(
              "PARTIAL_BLIND_GROUP_ADJUDICATION",
              `Adjudication must depend on every disclosed report in blind group ${group}.`,
              { missing_event_ids: missingGroupDependencies }
            );
          }
        }
        return appendEvent(root, {
          type: "adjudication",
          ...(input.run_id ? { run_id: input.run_id } : {}),
          actor: { id: input.actor_id, role: "adjudicator" },
          depends_on: input.depends_on,
          summary: `${input.finding_id}: ${input.disposition} — ${input.rationale}`,
          decisions: [
            {
              finding_id: input.finding_id,
              disposition: input.disposition,
              rationale: input.rationale,
              action: input.action,
              owner: input.owner,
              change_evidence: input.change_evidence
            }
          ]
        });
      })
  );

  server.registerTool(
    "research_verify_project",
    {
      title: "Verify Research Project",
      description:
        "Run deterministic schema, event-hash, packet-hash, canonical-file, source-freshness, and acceptance-syntax checks. This records a verification event but does not claim scientific correctness.",
      inputSchema: { project_root: z.string().min(1).max(4_096) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_root }) =>
      withProject(policy, project_root, (root) => verifyProject(root))
  );

  server.registerTool(
    "research_resolve_blocks",
    {
      title: "Resolve Explicit Research Blocks",
      description:
        "Append one immutable resolution event for explicit, currently unresolved blocking event IDs. Ordinary later work cannot silently clear a blocked project state.",
      inputSchema: {
        project_root: z.string().min(1).max(4_096),
        actor_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
        blocked_event_ids: z.array(z.string().uuid()).min(1).max(512),
        note: z.string().min(1).max(20_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_root, actor_id, blocked_event_ids, note }) =>
      withProject(policy, project_root, (root) =>
        resolveBlocks(root, actor_id, blocked_event_ids, note)
      )
  );

  server.registerTool(
    "research_record_provisional_review",
    {
      title: "Record Provisional Review",
      description:
        "Record a low-authority review of the current passing verification and add it to the human review queue. This never establishes scientific acceptance and never authorizes packaging.",
      inputSchema: {
        project_root: z.string().min(1).max(4_096),
        actor_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
        verification_event_id: z.string().uuid(),
        note: z.string().min(1).max(20_000),
        review_by: z.string().min(1).max(200).default("next human work session")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_root, actor_id, verification_event_id, note, review_by }) =>
      withProject(policy, project_root, (root) =>
        recordProvisionalReview(
          root,
          actor_id,
          verification_event_id,
          note,
          review_by
        )
      )
  );

  server.registerTool(
    "research_record_acceptance",
    {
      title: "Record Scientific Acceptance",
      description:
        "Record a named human acceptance after a passing deterministic verification. The actor must match an approved required authority in ACCEPTANCE.yaml.",
      inputSchema: {
        project_root: z.string().min(1).max(4_096),
        actor_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
        note: z.string().min(1).max(20_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_root, actor_id, note }) =>
      withProject(policy, project_root, (root) => recordAcceptance(root, actor_id, note))
  );

  server.registerTool(
    "research_package_handoff",
    {
      title: "Package Research Handoff",
      description:
        "Create a tar.gz from an explicit allowlist, write file hashes and provenance, reject likely credential files, extract in a clean temporary directory, verify every byte, and record packaged but not delivered.",
      inputSchema: {
        project_root: z.string().min(1).max(4_096),
        package_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        files: z.array(z.string().min(1).max(4_096)).min(1).max(1_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_root, package_id, files }) =>
      withProject(policy, project_root, (root) => packageHandoff(root, package_id, files))
  );

  server.registerResource(
    "research-steward-state-machine",
    "research-steward://protocol/state-machine",
    {
      title: "Research Steward State Machine",
      description: "Stable protocol states and authority boundary.",
      mimeType: "text/markdown"
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text:
            "# Implemented v0.1 states\n\ndraft -> frozen -> reviewing -> adjudicated -> verified -> accepted -> packaged\n\nAn unresolved blocking event overlays the stable state as `blocked`; an explicit `block_resolved` event restores progression. Candidate and delivery event names are reserved for a later first-class API. Deterministic verification does not establish scientific correctness."
        }
      ]
    })
  );

  return server;
}

async function configuredPolicy(): Promise<RootPolicy> {
  const policy = new RootPolicy();
  const configured = (process.env["RESEARCH_STEWARD_ROOTS"] ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  if (configured.length > 0) await policy.setRoots(configured);
  return policy;
}

async function attachClientRoots(server: McpServer, policy: RootPolicy): Promise<void> {
  if (policy.listRoots().length > 0) return;
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities?.roots) return;
  const response = await server.server.listRoots();
  const roots = response.roots
    .filter((root) => root.uri.startsWith("file:"))
    .map((root) => fileURLToPath(root.uri));
  if (roots.length > 0) await policy.setRoots(roots);
}

export async function runStdioServer(): Promise<void> {
  const policy = await configuredPolicy();
  const server = buildServer(policy);
  policy.setRootLoader(() => attachClientRoots(server, policy));
  server.server.oninitialized = () => {
    void policy.prepareRoots().catch((error: unknown) => {
      console.error(`Research Steward could not load client roots: ${errorMessage(error)}`);
    });
  };
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} ${SERVER_VERSION} running on stdio`);
}

function constantTimeTokenMatches(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isStrongHttpToken(token: string): boolean {
  if (token.length > 256 || /(replace|change|example|password|token)/i.test(token)) return false;
  return /^[a-fA-F0-9]{64,}$/.test(token) || /^[A-Za-z0-9_-]{43,}$/.test(token);
}

export async function runHttpServer(): Promise<void> {
  const token = process.env["RESEARCH_STEWARD_HTTP_TOKEN"] ?? "";
  if (!isStrongHttpToken(token)) {
    throw new ResearchStewardError(
      "HTTP_TOKEN_REQUIRED",
      "HTTP mode requires a non-placeholder 256-bit hex or 43+ character base64url bearer token."
    );
  }
  const policy = await configuredPolicy();
  if (policy.listRoots().length === 0) {
    throw new ResearchStewardError("NO_ALLOWED_ROOTS", "HTTP mode requires RESEARCH_STEWARD_ROOTS.");
  }

  const host = process.env["RESEARCH_STEWARD_HTTP_HOST"] ?? "127.0.0.1";
  const port = Number.parseInt(process.env["RESEARCH_STEWARD_HTTP_PORT"] ?? "8788", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ResearchStewardError("INVALID_HTTP_PORT", "Invalid HTTP port.");
  }
  const allowedHosts = new Set(
    (process.env["RESEARCH_STEWARD_ALLOWED_HOSTS"] ?? host)
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
  const allowedOrigins = new Set(
    (process.env["RESEARCH_STEWARD_ALLOWED_ORIGINS"] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use((request: Request, response: Response, next) => {
    const requestHost = (request.hostname ?? "").toLowerCase();
    if (!allowedHosts.has(requestHost)) {
      response.status(403).json({ error: "host_not_allowed" });
      return;
    }
    const origin = request.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      response.status(403).json({ error: "origin_not_allowed" });
      return;
    }
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id"
      );
      response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      response.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");
    }
    next();
  });

  app.get("/healthz", (_request, response) => {
    response.json({
      status: "ok",
      service: HEALTH_SERVICE_NAME,
      mcp_server: SERVER_NAME,
      version: SERVER_VERSION
    });
  });

  app.options("/mcp", (_request, response) => {
    response.status(204).end();
  });

  app.post("/mcp", async (request, response) => {
    const supplied = (request.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!constantTimeTokenMatches(token, supplied)) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const server = buildServer(policy);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) response.status(500).json({ error: "mcp_request_failed" });
      console.error(`Research Steward HTTP request failed: ${errorMessage(error)}`);
    }
  });
  app.all("/mcp", (_request, response) => {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "method_not_allowed" });
  });

  await new Promise<void>((resolve, reject) => {
    const listener = app.listen(port, host, () => {
      console.error(`${SERVER_NAME} ${SERVER_VERSION} listening on http://${host}:${port}/mcp`);
      resolve();
    });
    listener.once("error", reject);
  });
}
