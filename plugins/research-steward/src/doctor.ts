import { randomUUID } from "node:crypto";
import { constants, statSync } from "node:fs";
import { access, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PROTOCOL_VERSION } from "./protocol.js";

/**
 * Environment diagnostics for Research Steward. Every check is read-only apart
 * from one deliberately reversible write probe inside an explicitly supplied
 * project root. Doctor never spawns a provider process and never places an
 * environment value, token, or other secret material into a report.
 */

export const DoctorCheckSchema = z
  .object({
    id: z.string().min(1).max(100),
    status: z.enum(["pass", "warn", "fail", "skipped"]),
    summary: z.string().min(1).max(2_000),
    remediation: z.string().min(1).max(2_000).optional()
  })
  .strict();

export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

export const DoctorReportSchema = z
  .object({
    protocol_version: z.literal(PROTOCOL_VERSION),
    checked_at: z.string().datetime({ offset: true }),
    overall: z.enum(["pass", "warn", "fail"]),
    checks: z.array(DoctorCheckSchema).min(1)
  })
  .strict();

export type DoctorReport = z.infer<typeof DoctorReportSchema>;

export type ExecProbe = (name: string, explicit?: string) => Promise<string | undefined>;

export interface DoctorOptions {
  nodeVersion?: string;
  pluginRoot?: string;
  projectRoot?: string;
  env?: Readonly<Record<string, string | undefined>>;
  execProbe?: ExecProbe;
  /** Optional plan/lock JSON for adapter+model cross-check (CR-M-038). */
  plan?: unknown;
  lock?: unknown;
}

const PUBLIC_SCHEMA_FILES = [
  "project-manifest.schema.json",
  "research-event.schema.json",
  "roundtable-plan.schema.json",
  "doctor-report.schema.json",
  "workflow-lock.schema.json",
  "forecast.schema.json"
] as const;

const MINIMUM_SKILL_DIRECTORIES = 16;

/**
 * MCP tools the plugin is expected to register. Kept in sync with
 * src/server.ts by tests/wiring.test.ts (tool-count) and
 * tests/doctor.test.ts (inventory match). After adding a tool in server.ts,
 * append its name here in the same commit (RS-V1-SUP-006).
 */
export const EXPECTED_MCP_TOOLS: readonly string[] = [
  "research_init_project",
  "research_freeze_packet",
  "research_append_turn",
  "research_list_events",
  "research_get_status",
  "research_render_views",
  "research_run_roundtable",
  "research_adjudicate",
  "research_verify_project",
  "research_resolve_blocks",
  "research_record_provisional_review",
  "research_record_acceptance",
  "research_package_handoff",
  "research_doctor",
  "research_build_plan",
  "research_dry_run"
];

interface ProviderDescriptor {
  id: "qoder" | "kimi" | "grok";
  commandName: string;
  pathVariable: string;
}

/**
 * Provider command names and explicit-path variables mirror adapterDefaults()
 * in src/providers.ts. They are restated here so that loading doctor never
 * pulls in the provider spawn machinery.
 */
const PROVIDERS: readonly ProviderDescriptor[] = [
  { id: "qoder", commandName: "qoderclicn", pathVariable: "RESEARCH_STEWARD_QODER_PATH" },
  { id: "kimi", commandName: "kimi", pathVariable: "RESEARCH_STEWARD_KIMI_PATH" },
  { id: "grok", commandName: "grok", pathVariable: "RESEARCH_STEWARD_GROK_PATH" }
];

/**
 * Reimplementation of isStrongHttpToken() from src/server.ts, kept
 * byte-for-byte identical in behavior. Doctor must not import server.ts,
 * because that module loads express and the MCP transport stack; keep the two
 * predicates in sync whenever the token policy changes.
 */
function isStrongHttpToken(token: string): boolean {
  if (token.length > 256 || /(replace|change|example|password|token)/i.test(token)) return false;
  return /^[a-fA-F0-9]{64,}$/.test(token) || /^[A-Za-z0-9_-]{43,}$/.test(token);
}

/**
 * Executable discovery modeled on executableOnPath() in src/providers.ts, but
 * driven by the injected environment so tests can stay hermetic. It only asks
 * the filesystem whether a candidate is executable; it never runs anything.
 */
async function accessProbe(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  explicit?: string
): Promise<string | undefined> {
  const home = env["HOME"];
  const candidates = [
    explicit,
    ...(env["PATH"] ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, name)),
    ...(home
      ? [path.join(home, ".local", "bin", name), path.join(home, ".kimi-code", "bin", name)]
      : [])
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Keep probing the remaining candidates.
    }
  }
  return undefined;
}

function defaultPluginRoot(): string {
  // src/doctor.ts and the bundled dist/*.mjs both sit one level below the
  // plugin root, so the module's parent directory is the root in either form.
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function checkNodeVersion(nodeVersion: string): DoctorCheck {
  const match = /^v?(\d+)/.exec(nodeVersion.trim());
  if (!match) {
    return {
      id: "node.version",
      status: "warn",
      summary: "The Node.js version string could not be parsed.",
      remediation: "Run doctor under a standard Node.js runtime (node --version should print v20+)."
    };
  }
  const major = Number.parseInt(match[1]!, 10);
  if (major >= 20) {
    return {
      id: "node.version",
      status: "pass",
      summary: `Node.js major version ${major} satisfies the supported floor (20+).`
    };
  }
  if (major >= 18) {
    return {
      id: "node.version",
      status: "warn",
      summary: `Node.js major version ${major} is below the supported floor of 20.`,
      remediation: "Upgrade to Node.js 20 or newer; the package.json engines field requires >=20."
    };
  }
  return {
    id: "node.version",
    status: "fail",
    summary: `Node.js major version ${major} is unsupported.`,
    remediation: "Install Node.js 20 or newer before using Research Steward."
  };
}

async function nonEmptyFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function checkBundle(pluginRoot: string): Promise<DoctorCheck> {
  const bundles = ["cli.mjs", "server.mjs"];
  const missing: string[] = [];
  for (const bundle of bundles) {
    if (!(await nonEmptyFile(path.join(pluginRoot, "dist", bundle)))) missing.push(bundle);
  }
  if (missing.length > 0) {
    return {
      id: "bundle.dist",
      status: "fail",
      summary: `Missing or empty dist bundle files: ${missing.join(", ")}.`,
      remediation: "Run npm run build inside the plugin directory to produce dist/cli.mjs and dist/server.mjs."
    };
  }
  return {
    id: "bundle.dist",
    status: "pass",
    summary: "dist/cli.mjs and dist/server.mjs are present and non-empty."
  };
}

async function checkSchemas(pluginRoot: string): Promise<DoctorCheck> {
  const broken: string[] = [];
  for (const name of PUBLIC_SCHEMA_FILES) {
    try {
      JSON.parse(await readFile(path.join(pluginRoot, "schemas", name), "utf8"));
    } catch {
      broken.push(name);
    }
  }
  if (broken.length > 0) {
    return {
      id: "schemas.public",
      status: "fail",
      summary: `Public schema files are missing or unparsable: ${broken.join(", ")}.`,
      remediation: "Regenerate the published schemas (npm run build runs the schema generator)."
    };
  }
  return {
    id: "schemas.public",
    status: "pass",
    summary: `${PUBLIC_SCHEMA_FILES.length} public schema files exist and parse as JSON.`
  };
}

async function checkSkills(pluginRoot: string): Promise<DoctorCheck> {
  let count = 0;
  try {
    const entries = await readdir(path.join(pluginRoot, "skills"), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await nonEmptyFile(path.join(pluginRoot, "skills", entry.name, "SKILL.md"))) count += 1;
    }
  } catch {
    return {
      id: "skills.inventory",
      status: "fail",
      summary: "The skills/ directory is missing or unreadable.",
      remediation: "Reinstall the plugin so its bundled skills/ directory is restored."
    };
  }
  if (count < MINIMUM_SKILL_DIRECTORIES) {
    return {
      id: "skills.inventory",
      status: "fail",
      summary: `Only ${count} skill directories contain SKILL.md; at least ${MINIMUM_SKILL_DIRECTORIES} are expected.`,
      remediation: "Reinstall the plugin so its bundled skills/ directory is restored."
    };
  }
  return {
    id: "skills.inventory",
    status: "pass",
    summary: `${count} skill directories contain SKILL.md.`
  };
}

async function checkMcpManifest(pluginRoot: string): Promise<DoctorCheck> {
  try {
    const parsed = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8")) as unknown;
    const servers =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)["mcpServers"]
        : undefined;
    const entry =
      servers !== null && typeof servers === "object"
        ? (servers as Record<string, unknown>)["research-steward"]
        : undefined;
    if (entry !== null && typeof entry === "object") {
      return {
        id: "mcp.manifest",
        status: "pass",
        summary: ".mcp.json parses and declares the research-steward server."
      };
    }
    return {
      id: "mcp.manifest",
      status: "fail",
      summary: ".mcp.json parses but has no research-steward server entry.",
      remediation: "Restore the mcpServers.research-steward entry in the plugin's .mcp.json."
    };
  } catch {
    return {
      id: "mcp.manifest",
      status: "fail",
      summary: ".mcp.json is missing or is not valid JSON.",
      remediation: "Reinstall the plugin or restore its .mcp.json manifest."
    };
  }
}

async function checkProjectRoot(projectRoot: string | undefined): Promise<DoctorCheck> {
  if (projectRoot === undefined) {
    return {
      id: "project.root",
      status: "skipped",
      summary: "No project root was provided, so project checks were skipped."
    };
  }
  try {
    const info = await stat(projectRoot);
    if (!info.isDirectory()) {
      return {
        id: "project.root",
        status: "fail",
        summary: "The project root exists but is not a directory.",
        remediation: "Point doctor at the directory that holds (or will hold) the .research workspace."
      };
    }
  } catch {
    return {
      id: "project.root",
      status: "fail",
      summary: "The project root does not exist or is not accessible.",
      remediation: "Create the project directory or fix its permissions before running Research Steward."
    };
  }

  // Probe lives in the project root (not .research/) so it works before the
  // workspace exists; it is always removed below. Residue from an interrupted
  // run is swept first (CR-M-026/027).
  const probePrefix = ".research-steward-doctor-";
  try {
    for (const name of await readdir(projectRoot)) {
      if (name.startsWith(probePrefix) && name.endsWith(".tmp")) {
        await rm(path.join(projectRoot, name), { force: true }).catch(() => undefined);
      }
    }
  } catch {
    // Unreadable root is reported by the checks above; sweep is best-effort.
  }
  const probe = path.join(projectRoot, `${probePrefix}${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(probe, "doctor write probe\n", { flag: "wx", mode: 0o600 });
  } catch {
    return {
      id: "project.root",
      status: "fail",
      summary: "The project root is not writable by the current user.",
      remediation: "Grant write permission on the project directory; Research Steward records events inside it."
    };
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
  }

  let manifestNote = "no protocol manifest yet";
  try {
    const raw = await readFile(path.join(projectRoot, ".research", "manifest.json"), "utf8");
    JSON.parse(raw);
    manifestNote = "the existing .research/manifest.json parses";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        id: "project.root",
        status: "fail",
        summary: "The project's .research/manifest.json exists but cannot be read as JSON.",
        remediation: "Inspect .research/manifest.json; a corrupt manifest blocks every protocol operation."
      };
    }
  }
  return {
    id: "project.root",
    status: "pass",
    summary: `The project root is a writable directory (${manifestNote}).`
  };
}

async function checkProvider(
  provider: ProviderDescriptor,
  env: Readonly<Record<string, string | undefined>>,
  probe: ExecProbe
): Promise<DoctorCheck> {
  let found: string | undefined;
  try {
    found = await probe(provider.commandName, env[provider.pathVariable]);
  } catch {
    // A broken probe must not abort the whole report, and its error text may
    // carry filesystem paths or other user detail, so none of it is echoed.
    return {
      id: `provider.${provider.id}`,
      status: "warn",
      summary: `The executable probe for ${provider.commandName} failed, so its availability is unknown.`,
      remediation: `Check permissions on the directories in PATH, or set ${provider.pathVariable} to an absolute path, then rerun doctor.`
    };
  }
  if (found !== undefined) {
    // Deliberately reduced to the basename: the resolved path may reveal a
    // home directory or other user-specific layout.
    return {
      id: `provider.${provider.id}`,
      status: "pass",
      summary: `${path.basename(found)} found.`
    };
  }
  return {
    id: `provider.${provider.id}`,
    status: "warn",
    summary: `The ${provider.commandName} CLI was not found.`,
    remediation: `Install the ${provider.commandName} CLI or set ${provider.pathVariable} to its absolute path. Roundtable nodes using this adapter will fail until then.`
  };
}

function providerAuthCheck(provider: ProviderDescriptor): DoctorCheck {
  // Zero-cost constraint: doctor never invokes a provider, so it cannot know
  // (and must not claim) whether the CLI is authenticated.
  return {
    id: `provider.${provider.id}.auth`,
    status: "skipped",
    summary: `Authentication status is not probed; doctor never invokes the ${provider.commandName} CLI.`,
    remediation: `Verify manually, for example by running ${provider.commandName} --help and one small interactive request yourself.`
  };
}

function checkHttpToken(env: Readonly<Record<string, string | undefined>>): DoctorCheck {
  const token = env["RESEARCH_STEWARD_HTTP_TOKEN"];
  if (token === undefined || token === "") {
    return {
      id: "http.token",
      status: "skipped",
      summary: "RESEARCH_STEWARD_HTTP_TOKEN is not set; local stdio mode does not need it."
    };
  }
  if (!isStrongHttpToken(token)) {
    // Never echo the token, its length, or any derived detail.
    return {
      id: "http.token",
      status: "fail",
      summary: "RESEARCH_STEWARD_HTTP_TOKEN is set but does not meet strength policy.",
      remediation: "Generate a fresh secret (for example: openssl rand -hex 32) and replace the variable's value."
    };
  }
  return {
    id: "http.token",
    status: "pass",
    summary: "RESEARCH_STEWARD_HTTP_TOKEN is set and meets strength policy."
  };
}

function checkRouteBilling(env: Readonly<Record<string, string | undefined>>): DoctorCheck {
  // Presence only; the values are intentionally never read into the report.
  const notes: string[] = [];
  if (env["XAI_API_KEY"] !== undefined) {
    notes.push(
      "XAI_API_KEY is present; the Grok adapter strips it explicitly so calls stay on the CLI session instead of the metered xAI API"
    );
  }
  if (env["DEEPSEEK_API_KEY"] !== undefined) {
    notes.push("DEEPSEEK_API_KEY is a metered API key present in the environment; Research Steward will not use it");
  }
  if (notes.length > 0) {
    return {
      id: "route.billing",
      status: "warn",
      summary: `${notes.join(". ")}.`,
      remediation: "Unset metered API keys in the shell that runs Research Steward if you want zero billing exposure."
    };
  }
  return {
    id: "route.billing",
    status: "pass",
    summary: "No metered API keys were detected in the environment."
  };
}

async function checkMcpToolInventory(pluginRoot: string): Promise<DoctorCheck> {
  // Compare EXPECTED_MCP_TOOLS against the bundled server source. Doctor never
  // starts the MCP process (CR-M-037).
  let source: string;
  try {
    source = await readFile(path.join(pluginRoot, "src", "server.ts"), "utf8");
  } catch {
    try {
      source = await readFile(path.join(pluginRoot, "dist", "server.mjs"), "utf8");
    } catch {
      return {
        id: "mcp.tools",
        status: "fail",
        summary: "Neither src/server.ts nor dist/server.mjs is readable to inventory MCP tools.",
        remediation: "Reinstall the plugin so its server bundle is present."
      };
    }
  }
  const missing = EXPECTED_MCP_TOOLS.filter((tool) => !source.includes(`"${tool}"`));
  if (missing.length > 0) {
    return {
      id: "mcp.tools",
      status: "fail",
      summary: `Server source is missing ${missing.length} expected MCP tool name(s) (names withheld).`,
      remediation: "Update EXPECTED_MCP_TOOLS or restore the missing tool registrations."
    };
  }
  return {
    id: "mcp.tools",
    status: "pass",
    summary: `All ${EXPECTED_MCP_TOOLS.length} expected MCP tool names appear in the server source.`
  };
}

function checkRootPolicy(env: Readonly<Record<string, string | undefined>>): DoctorCheck {
  const raw = env["RESEARCH_STEWARD_ROOTS"] ?? "";
  const parts = raw
    .split(/[:;]/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) {
    return {
      id: "roots.policy",
      status: "warn",
      summary: "RESEARCH_STEWARD_ROOTS is unset; MCP/HTTP modes that require allowed roots will refuse to resolve projects.",
      remediation: "Export RESEARCH_STEWARD_ROOTS with one or more existing project parent directories."
    };
  }
  const bad = parts.filter((part) => {
    try {
      return !statSync(part).isDirectory();
    } catch {
      return true;
    }
  });
  if (bad.length > 0) {
    return {
      id: "roots.policy",
      status: "fail",
      summary: `RESEARCH_STEWARD_ROOTS lists ${bad.length} path(s) that are not existing directories (values withheld).`,
      remediation: "Point RESEARCH_STEWARD_ROOTS only at directories that exist on this machine."
    };
  }
  return {
    id: "roots.policy",
    status: "pass",
    summary: `RESEARCH_STEWARD_ROOTS lists ${parts.length} existing director${parts.length === 1 ? "y" : "ies"}.`
  };
}

const PLACEHOLDER_MODEL = /replace|your-model|example-model|changeme|todo-model/i;

/**
 * Static adapter+model compatibility from a plan/lock (CR-M-038). Used when
 * the caller supplies plan or lock JSON; env-only checks stay weaker.
 */
export function checkModelRouteFromPlan(plan: unknown): DoctorCheck {
  const nodes =
    plan !== null && typeof plan === "object"
      ? (plan as { nodes?: unknown }).nodes
      : undefined;
  if (!Array.isArray(nodes)) {
    return {
      id: "route.model",
      status: "skipped",
      summary: "No plan nodes supplied; adapter/model cross-check skipped."
    };
  }
  const issues: string[] = [];
  for (const node of nodes) {
    if (node === null || typeof node !== "object") continue;
    const adapter = (node as { adapter?: unknown }).adapter;
    const model = (node as { model?: unknown }).model;
    if (typeof adapter !== "string" || typeof model !== "string" || model === "") continue;
    if (PLACEHOLDER_MODEL.test(model)) {
      issues.push(`node uses a placeholder model name`);
      continue;
    }
    // Heuristic: a model string naming a different vendor CLI is a likely mismatch.
    const modelVendor = /gpt|o1|claude|sonnet|haiku|deepseek|gemini|grok|kimi|qoder/i.exec(
      model
    );
    if (modelVendor === null) continue;
    const vendor = modelVendor[0]!.toLowerCase();
    const adapterVendor =
      adapter === "kimi"
        ? "kimi"
        : adapter === "grok"
          ? "grok"
          : adapter === "qoder"
            ? "qoder"
            : adapter === "fake"
              ? null
              : null;
    if (adapterVendor !== null && !vendor.includes(adapterVendor) && adapterVendor !== "qoder") {
      // grok adapter + kimi model name etc.
      if ((adapterVendor === "grok" && !vendor.includes("grok")) ||
          (adapterVendor === "kimi" && !vendor.includes("kimi"))) {
        issues.push(`adapter/model vendor mismatch`);
      }
    }
  }
  if (issues.length > 0) {
    return {
      id: "route.model",
      status: "fail",
      summary: `Plan model-route check found ${issues.length} issue(s) (details withheld).`,
      remediation: "Align each node model with its adapter, or use the fake adapter for rehearsal."
    };
  }
  return {
    id: "route.model",
    status: "pass",
    summary: "Plan adapter/model pairs look consistent (static heuristic)."
  };
}

function checkModelRoute(env: Readonly<Record<string, string | undefined>>): DoctorCheck {
  const model = env["RESEARCH_STEWARD_MODEL"] ?? env["RESEARCH_STEWARD_DEFAULT_MODEL"];
  if (model === undefined || model.trim() === "") {
    return {
      id: "route.model",
      status: "skipped",
      summary: "No RESEARCH_STEWARD_MODEL is set; provider CLI defaults apply."
    };
  }
  if (PLACEHOLDER_MODEL.test(model) || model.length > 100) {
    return {
      id: "route.model",
      status: "fail",
      summary: "The configured model name looks like a placeholder or is implausibly long (value withheld).",
      remediation: "Set RESEARCH_STEWARD_MODEL to a real model identifier your subscription CLI accepts."
    };
  }
  // A non-placeholder env name is not independently verified against a
  // provider catalog — that requires plan/lock input (CR-M-038/041).
  return {
    id: "route.model",
    status: "skipped",
    summary: "RESEARCH_STEWARD_MODEL is set; compatibility with provider catalogs is not verified from env alone."
  };
}

function aggregateOverall(checks: readonly DoctorCheck[]): "pass" | "warn" | "fail" {
  // skipped is deliberately neutral: it neither upgrades nor downgrades.
  if (checks.some((item) => item.status === "fail")) return "fail";
  if (checks.some((item) => item.status === "warn")) return "warn";
  return "pass";
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.version;
  const pluginRoot = options.pluginRoot ?? defaultPluginRoot();
  const probe = options.execProbe ?? ((name, explicit) => accessProbe(env, name, explicit));

  const checks: DoctorCheck[] = [
    checkNodeVersion(nodeVersion),
    await checkBundle(pluginRoot),
    await checkSchemas(pluginRoot),
    await checkSkills(pluginRoot),
    await checkMcpManifest(pluginRoot),
    await checkProjectRoot(options.projectRoot)
  ];
  for (const provider of PROVIDERS) {
    checks.push(await checkProvider(provider, env, probe));
    checks.push(providerAuthCheck(provider));
  }
  checks.push(checkHttpToken(env), checkRouteBilling(env));
  checks.push(await checkMcpToolInventory(pluginRoot), checkRootPolicy(env), checkModelRoute(env));
  if (options.plan !== undefined || options.lock !== undefined) {
    checks.push(checkModelRouteFromPlan(options.plan ?? options.lock));
  }

  return DoctorReportSchema.parse({
    protocol_version: PROTOCOL_VERSION,
    checked_at: new Date().toISOString(),
    overall: aggregateOverall(checks),
    checks
  });
}
