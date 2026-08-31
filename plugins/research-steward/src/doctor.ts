import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
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
}

const PUBLIC_SCHEMA_FILES = [
  "project-manifest.schema.json",
  "research-event.schema.json",
  "roundtable-plan.schema.json"
] as const;

const MINIMUM_SKILL_DIRECTORIES = 8;

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

  const probe = path.join(projectRoot, `.research-steward-doctor-${process.pid}-${randomUUID()}.tmp`);
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

  return DoctorReportSchema.parse({
    protocol_version: PROTOCOL_VERSION,
    checked_at: new Date().toISOString(),
    overall: aggregateOverall(checks),
    checks
  });
}
