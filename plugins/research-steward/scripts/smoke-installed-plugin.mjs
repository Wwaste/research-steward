// Smoke test for the installed-plugin surface.
//
// Default mode (used in CI, zero network): copy the files a Codex install
// cache would materialize into a temporary "replica", check the static plugin
// surface, then drive the replica's bundled MCP server end to end through a
// client-granted root. The MCP SDK is resolved from the source tree's
// node_modules because this script lives in the source tree.
//
// --use-codex-cli (manual, local only): run a real `codex plugin marketplace
// add` against an isolated CODEX_HOME. CI must not use this mode.

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");
const EXPECTED_SKILL_COUNT = 8;
const EXPECTED_TOOL_COUNT = 16;
const SCHEMA_FILES = [
  "project-manifest.schema.json",
  "research-event.schema.json",
  "roundtable-plan.schema.json",
  "doctor-report.schema.json",
  "workflow-lock.schema.json",
  "forecast.schema.json"
];

function fail(message) {
  throw new Error(message);
}

async function buildReplica(replicaRoot) {
  await mkdir(path.join(replicaRoot, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(replicaRoot, "dist"), { recursive: true });
  await mkdir(path.join(replicaRoot, "schemas"), { recursive: true });
  await cp(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    path.join(replicaRoot, ".codex-plugin", "plugin.json")
  );
  await cp(path.join(pluginRoot, ".mcp.json"), path.join(replicaRoot, ".mcp.json"));
  for (const bundle of ["cli.mjs", "server.mjs"]) {
    await cp(path.join(pluginRoot, "dist", bundle), path.join(replicaRoot, "dist", bundle));
  }
  await cp(path.join(pluginRoot, "skills"), path.join(replicaRoot, "skills"), {
    recursive: true
  });
  for (const schema of SCHEMA_FILES) {
    await cp(
      path.join(pluginRoot, "schemas", schema),
      path.join(replicaRoot, "schemas", schema)
    );
  }
}

async function checkStaticSurface(replicaRoot) {
  const manifest = JSON.parse(
    await readFile(path.join(replicaRoot, ".codex-plugin", "plugin.json"), "utf8")
  );
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    fail("plugin.json parsed but has no usable name field");
  }
  const skillEntries = await readdir(path.join(replicaRoot, "skills"), {
    withFileTypes: true
  });
  const skillDirs = skillEntries.filter((entry) => entry.isDirectory());
  if (skillDirs.length !== EXPECTED_SKILL_COUNT) {
    fail(`expected exactly ${EXPECTED_SKILL_COUNT} skills, found ${skillDirs.length}`);
  }
  for (const skill of skillDirs) {
    await stat(path.join(replicaRoot, "skills", skill.name, "SKILL.md")).catch(() =>
      fail(`skill ${skill.name} is missing SKILL.md`)
    );
  }
  for (const schema of SCHEMA_FILES) {
    await stat(path.join(replicaRoot, "schemas", schema)).catch(() =>
      fail(`schema ${schema} missing from the replica`)
    );
  }
  return { manifestName: manifest.name, skills: skillDirs.length };
}

async function driveReplicaServer(replicaRoot, projectRoot) {
  const env = { ...process.env };
  delete env.RESEARCH_STEWARD_ROOTS;
  const client = new Client(
    { name: "research-steward-installed-smoke", version: "1.0.0" },
    { capabilities: { roots: {} } }
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(projectRoot).href, name: "installed-smoke-root" }]
  }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(replicaRoot, "dist", "server.mjs")],
    cwd: replicaRoot,
    env
  });
  try {
    await client.connect(transport);
    const initialized = await client.callTool({
      name: "research_init_project",
      arguments: { project_root: projectRoot, title: "Installed-plugin smoke project" }
    });
    if (initialized.isError) {
      const detail = initialized.content.find((item) => item.type === "text")?.text;
      fail(`research_init_project failed against the replica: ${detail ?? "unknown error"}`);
    }
    const status = await client.callTool({
      name: "research_get_status",
      arguments: { project_root: projectRoot }
    });
    if (status.isError) fail("research_get_status failed against the replica");
    const tools = await client.listTools();
    if (tools.tools.length !== EXPECTED_TOOL_COUNT) {
      fail(
        `expected exactly ${EXPECTED_TOOL_COUNT} tools, found ${tools.tools.length}`
      );
    }
    return { tools: tools.tools.length, init: "pass", status: "pass" };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runReplicaMode() {
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "research-steward-installed-"));
  try {
    const replicaRoot = path.join(workRoot, "install-cache");
    const projectRoot = path.join(workRoot, "project");
    await mkdir(replicaRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await buildReplica(replicaRoot);
    const surface = await checkStaticSurface(replicaRoot);
    const runtime = await driveReplicaServer(replicaRoot, projectRoot);
    process.stdout.write(
      `${JSON.stringify({
        mode: "install-cache-replica",
        plugin_manifest: surface.manifestName,
        skills: surface.skills,
        schemas: SCHEMA_FILES.length,
        environment_root_absent: true,
        client_roots: "pass",
        tools: runtime.tools,
        init: runtime.init,
        status: runtime.status
      })}\n`
    );
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function runCodexCliMode() {
  process.stdout.write(
    [
      "Manual mode: installs this checkout through the real codex CLI.",
      "An isolated temporary CODEX_HOME is used so your local codex state is untouched.",
      "This mode is for a local machine only; CI uses the default replica mode.",
      ""
    ].join("\n")
  );
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    process.stderr.write(
      "codex CLI not found on PATH; install Codex before using --use-codex-cli\n"
    );
    process.exit(2);
  }
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "research-steward-codex-home-"));
  try {
    const env = { ...process.env, CODEX_HOME: codexHome };
    const added = spawnSync("codex", ["plugin", "marketplace", "add", repoRoot], {
      env,
      stdio: "inherit"
    });
    if (added.status !== 0) {
      fail(`codex plugin marketplace add exited with status ${added.status}`);
    }
    const installed = spawnSync(
      "codex",
      ["plugin", "add", "research-steward@research-steward"],
      { env, stdio: "inherit" }
    );
    if (installed.status !== 0) {
      fail(`codex plugin add exited with status ${installed.status}`);
    }
    process.stdout.write(
      `${JSON.stringify({ mode: "codex-cli", marketplace_add: "pass", plugin_add: "pass" })}\n`
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

try {
  if (process.argv.includes("--use-codex-cli")) {
    await runCodexCliMode();
  } else {
    await runReplicaMode();
  }
} catch (error) {
  process.stderr.write(`installed-plugin smoke failed: ${error?.message ?? error}\n`);
  process.exit(1);
}
