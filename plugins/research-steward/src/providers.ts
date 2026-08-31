import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { ModelOutputSchema, type ModelOutput, type RoundtableNode } from "./protocol.js";
import { ResearchStewardError, bounded, sha256Text, writeImmutableFile } from "./utils.js";

const MAX_ARG_PROMPT_BYTES = 96_000;
let activeProviderProcesses = 0;
const providerWaiters: Array<() => void> = [];

export interface ProviderRunResult {
  output: ModelOutput;
  adapter: RoundtableNode["adapter"];
  model: string;
  duration_ms: number;
  exit_code: number;
  stdout_hash: string;
  stdout_chars: number;
  stderr_hash: string;
  stderr_chars: number;
  executable_name: string;
}

const GROK_EVIDENCE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["locator", "kind", "note"],
  properties: {
    locator: { type: "string" },
    kind: {
      type: "string",
      enum: ["source", "artifact", "command", "observation", "other"]
    },
    note: { type: "string" }
  }
} as const;

const GROK_MODEL_OUTPUT_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "uncertainties", "evidence", "findings", "decisions"],
  properties: {
    status: { type: "string", enum: ["complete", "blocked"] },
    summary: { type: "string" },
    uncertainties: { type: "array", items: { type: "string" } },
    evidence: {
      type: "array",
      items: GROK_EVIDENCE_JSON_SCHEMA
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "severity", "claim", "evidence", "uncertainty", "remediation"],
        properties: {
          id: { type: "string" },
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low", "info"]
          },
          claim: { type: "string" },
          evidence: { type: "array", items: GROK_EVIDENCE_JSON_SCHEMA },
          uncertainty: { type: "string" },
          remediation: { type: "string" }
        }
      }
    },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["finding_id", "disposition", "rationale", "action", "owner", "change_evidence"],
        properties: {
          finding_id: { type: "string" },
          disposition: {
            type: "string",
            enum: ["accept", "partial", "reject", "defer"]
          },
          rationale: { type: "string" },
          action: { type: "string" },
          owner: { type: "string" },
          change_evidence: { type: "string" }
        }
      }
    }
  }
});

function childEnvironment(adapter: RoundtableNode["adapter"]): NodeJS.ProcessEnv {
  const allowed = [
    "HOME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "COLORTERM",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR"
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (adapter !== "grok" && process.env["HTTPS_PROXY"]) {
    environment["HTTPS_PROXY"] = process.env["HTTPS_PROXY"];
  }
  // Grok must use its configured subscription/OAuth session. Never silently
  // inherit XAI_API_KEY, which may route to separately metered API billing.
  delete environment["XAI_API_KEY"];
  return environment;
}

async function executableOnPath(name: string, explicit?: string): Promise<string | undefined> {
  const home = process.env["HOME"];
  const candidates = [
    explicit,
    ...(process.env["PATH"] ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, name)),
    ...(home
      ? [
          path.join(home, ".local", "bin", name),
          path.join(home, ".kimi-code", "bin", name)
        ]
      : [])
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue discovery without invoking a shell.
    }
  }
  return undefined;
}

function providerConcurrencyLimit(): number {
  const parsed = Number.parseInt(
    process.env["RESEARCH_STEWARD_MAX_PROVIDER_CONCURRENCY"] ?? "3",
    10
  );
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) {
    throw new ResearchStewardError(
      "INVALID_PROVIDER_CONCURRENCY",
      "RESEARCH_STEWARD_MAX_PROVIDER_CONCURRENCY must be an integer from 1 to 16."
    );
  }
  return parsed;
}

function releaseProviderPermit(): void {
  activeProviderProcesses = Math.max(0, activeProviderProcesses - 1);
  const next = providerWaiters.shift();
  if (next) next();
}

async function acquireProviderPermit(timeoutMs: number): Promise<() => void> {
  if (activeProviderProcesses < providerConcurrencyLimit()) {
    activeProviderProcesses += 1;
    return releaseProviderPermit;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const ready = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeProviderProcesses += 1;
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const index = providerWaiters.indexOf(ready);
      if (index >= 0) providerWaiters.splice(index, 1);
      reject(
        new ResearchStewardError(
          "PROVIDER_QUEUE_TIMEOUT",
          "Provider call could not start within its bounded deadline."
        )
      );
    }, timeoutMs);
    timer.unref();
    providerWaiters.push(ready);
  });
  return releaseProviderPermit;
}

function adapterDefaults(node: RoundtableNode): {
  commandName: string;
  explicitPath?: string;
  model: string;
  args: (prompt: string, cwd: string, skillsDirectory: string, promptFile: string) => string[];
} {
  switch (node.adapter) {
    case "kimi":
      return {
        commandName: "kimi",
        explicitPath: process.env["RESEARCH_STEWARD_KIMI_PATH"],
        model: node.model ?? "kimi-code/k3",
        args: (prompt, _cwd, skillsDirectory) => [
          "--model",
          node.model ?? "kimi-code/k3",
          "--skills-dir",
          skillsDirectory,
          "--prompt",
          prompt,
          "--output-format",
          "text"
        ]
      };
    case "qoder":
      return {
        commandName: "qoderclicn",
        explicitPath: process.env["RESEARCH_STEWARD_QODER_PATH"],
        model: node.model ?? "GLM-5.3-Flash",
        args: (prompt, cwd, skillsDirectory) => [
          "--model",
          node.model ?? "GLM-5.3-Flash",
          "--cwd",
          cwd,
          "--permission-mode",
          "dont_ask",
          "--tools",
          "",
          "--plugin-dir",
          skillsDirectory,
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--output-format",
          "json",
          "--input-format",
          "text",
          "--max-model-request-retries",
          "1",
          "--max-output-tokens",
          "4096",
          "--no-session-persistence",
          "--print"
        ]
      };
    case "grok":
      return {
        commandName: "grok",
        explicitPath: process.env["RESEARCH_STEWARD_GROK_PATH"],
        model: node.model ?? "grok-4.6",
        args: (_prompt, cwd, _skillsDirectory, promptFile) => [
          "--model",
          node.model ?? "grok-4.6",
          "--verbatim",
          "--cwd",
          cwd,
          "--prompt-file",
          promptFile,
          "--json-schema",
          GROK_MODEL_OUTPUT_JSON_SCHEMA,
          "--max-turns",
          "1",
          "--no-plan",
          "--disable-web-search",
          "--no-subagents",
          "--permission-mode",
          "dontAsk",
          "--tools",
          ""
        ]
      };
    case "fake":
      return {
        commandName: "fake",
        model: node.model ?? "deterministic-test-double",
        args: () => []
      };
  }
}

function extractJsonCandidate(raw: string): unknown {
  const trimmed = raw.trim();
  const directCandidates = [trimmed];

  const fenced = trimmed.match(/\x60\x60\x60(?:json)?\s*([\s\S]*?)\x60\x60\x60/i);
  if (fenced?.[1]) directCandidates.push(fenced[1].trim());

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    directCandidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of directCandidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        const structuredOutput = record["structuredOutput"];
        if (
          structuredOutput !== null &&
          typeof structuredOutput === "object" &&
          !Array.isArray(structuredOutput)
        ) {
          return structuredOutput;
        }
        for (const key of ["result", "response", "content", "text", "message"]) {
          const nested = record[key];
          if (typeof nested === "string") {
            try {
              return extractJsonCandidate(nested);
            } catch {
              // Keep trying the outer object.
            }
          }
        }
      }
      return parsed;
    } catch {
      // Try the next extraction strategy.
    }
  }
  throw new ResearchStewardError("INVALID_MODEL_JSON", "Provider output did not contain a valid JSON object.");
}

function normalizeEvidence(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) =>
    typeof item === "string"
      ? { locator: item, kind: "other" }
      : item
  );
}

function normalizeModelOutput(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  record["evidence"] = normalizeEvidence(record["evidence"] ?? []);
  if (Array.isArray(record["findings"])) {
    record["findings"] = record["findings"].map((finding) => {
      if (finding === null || typeof finding !== "object" || Array.isArray(finding)) return finding;
      const normalized = { ...(finding as Record<string, unknown>) };
      normalized["evidence"] = normalizeEvidence(normalized["evidence"] ?? []);
      return normalized;
    });
  }
  return record;
}

function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maximumOutput: number,
  adapter: RoundtableNode["adapter"],
  stdinText?: string
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const detached = process.platform !== "win32";
    const child = spawn(executable, [...args], {
      cwd,
      env: childEnvironment(adapter),
      shell: false,
      stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      detached
    });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    if (stdinText !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdinText);
    }

    const terminateTree = (signal: NodeJS.Signals): void => {
      try {
        if (detached && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // The process may already have exited.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree("SIGTERM");
      killTimer = setTimeout(() => terminateTree("SIGKILL"), 2_000);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > maximumOutput * 2) {
        exceeded = true;
        terminateTree("SIGTERM");
      }
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr = bounded(stderr + chunk, 20_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      reject(
        new ResearchStewardError("PROVIDER_SPAWN_FAILED", "Provider process could not start.", {
          error_name: error.name,
          error_code: (error as NodeJS.ErrnoException).code ?? "unknown"
        })
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      const safeDetails = {
        duration_ms: Date.now() - started,
        exit_code: code ?? -1,
        stdout_hash: sha256Text(stdout),
        stdout_chars: stdout.length,
        stderr_hash: sha256Text(stderr),
        stderr_chars: stderr.length
      };
      if (timedOut) {
        reject(
          new ResearchStewardError(
            "PROVIDER_TIMEOUT",
            `Provider timed out after ${timeoutMs} ms.`,
            safeDetails
          )
        );
        return;
      }
      if (exceeded) {
        reject(
          new ResearchStewardError(
            "PROVIDER_OUTPUT_LIMIT",
            "Provider exceeded the configured output limit.",
            safeDetails
          )
        );
        return;
      }
      resolve({
        stdout: bounded(stdout, maximumOutput),
        stderr: bounded(stderr, 8_000),
        exitCode: code ?? -1,
        durationMs: Date.now() - started
      });
    });
  });
}

export function modelOutputContract(): string {
  return `Return exactly one JSON object and no prose outside it. Do not reveal hidden chain-of-thought. Use this shape:
{
  "status": "complete" | "blocked",
  "summary": "concise result and reasoning summary",
  "uncertainties": ["explicit uncertainty"],
  "evidence": [{"locator":"file, section, command, or source", "kind":"source|artifact|command|observation|other", "note":"optional"}],
  "findings": [{"id":"stable-id", "severity":"critical|high|medium|low|info", "claim":"finding", "evidence":[], "uncertainty":"", "remediation":""}],
  "decisions": [{"finding_id":"stable-id", "disposition":"accept|partial|reject|defer", "rationale":"why", "action":"", "owner":"", "change_evidence":""}]
}`;
}

export async function runProvider(
  node: RoundtableNode,
  prompt: string,
  _projectRoot: string,
  maximumOutput: number
): Promise<ProviderRunResult> {
  const defaults = adapterDefaults(node);

  if (node.adapter === "fake") {
    if (process.env["RESEARCH_STEWARD_ENABLE_FAKE_ADAPTER"] !== "1") {
      throw new ResearchStewardError("FAKE_ADAPTER_DISABLED", "The deterministic fake adapter is test-only.");
    }
    const dependencyStart = prompt.indexOf("=== SELECTED COMMITTED DEPENDENCIES ===");
    const dependencyEnd = prompt.indexOf("=== FROZEN INPUT ===");
    const dependencyText =
      dependencyStart >= 0 && dependencyEnd > dependencyStart
        ? prompt.slice(dependencyStart, dependencyEnd)
        : "";
    const dependencyFindingIds = [
      ...new Set(
        [...dependencyText.matchAll(/"id":\s*"([a-zA-Z0-9._-]+)"/g)]
          .map((match) => match[1])
          .filter((value): value is string => value !== undefined)
      )
    ];
    const isReviewer = /review|critic/i.test(node.role);
    const output = ModelOutputSchema.parse({
      status: "complete",
      summary: `Deterministic response for ${node.id}: ${node.brief}`,
      uncertainties: ["This is a test double, not a scientific model review."],
      evidence: [],
      findings:
        !node.can_adjudicate && isReviewer
          ? [
              {
                id: "demonstration-finding",
                severity: "info",
                claim: "The deterministic walkthrough requires human interpretation; this is not a scientific finding.",
                evidence: [],
                uncertainty: "Generated by the test-only fake adapter.",
                remediation: "Replace the fake plan with a bounded live review plan for real work."
              }
            ]
          : [],
      decisions: node.can_adjudicate
        ? dependencyFindingIds.map((findingId) => ({
            finding_id: findingId,
            disposition: "defer",
            rationale: "The deterministic test double cannot make a scientific disposition.",
            action: "Request named human or bounded live-model review.",
            owner: "researcher",
            change_evidence: "A real evidence-based review."
          }))
        : []
    });
    const serialized = JSON.stringify(output);
    return {
      output,
      adapter: node.adapter,
      model: defaults.model,
      duration_ms: 0,
      exit_code: 0,
      stdout_hash: sha256Text(serialized),
      stdout_chars: serialized.length,
      stderr_hash: sha256Text(""),
      stderr_chars: 0,
      executable_name: "fake"
    };
  }

  const executable = await executableOnPath(defaults.commandName, defaults.explicitPath);
  if (!executable) {
    throw new ResearchStewardError(
      "PROVIDER_NOT_FOUND",
      `Provider CLI is not executable: ${defaults.commandName}. Configure its explicit RESEARCH_STEWARD_*_PATH variable.`
    );
  }
  if (
    node.adapter === "kimi" &&
    Buffer.byteLength(prompt, "utf8") > MAX_ARG_PROMPT_BYTES
  ) {
    throw new ResearchStewardError(
      "PROVIDER_PROMPT_ARG_LIMIT",
      `The Kimi CLI requires an argv prompt; its sealed limit is ${MAX_ARG_PROMPT_BYTES} UTF-8 bytes.`
    );
  }

  const sealedRoot = await mkdtemp(path.join(os.tmpdir(), "research-steward-provider-"));
  const sealedWorkspace = path.join(sealedRoot, "workspace");
  const emptySkills = path.join(sealedRoot, "skills");
  const promptFile = path.join(sealedRoot, "prompt.txt");
  await Promise.all([
    mkdir(sealedWorkspace, { mode: 0o700 }),
    mkdir(emptySkills, { mode: 0o700 }),
    writeImmutableFile(promptFile, prompt, 0o600)
  ]);
  const queuedAt = Date.now();
  let release: (() => void) | undefined;
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    release = await acquireProviderPermit(node.timeout_ms);
    const remainingMs = node.timeout_ms - (Date.now() - queuedAt);
    if (remainingMs < 1_000) {
      throw new ResearchStewardError(
        "PROVIDER_QUEUE_TIMEOUT",
        "Provider call reached its deadline before process start."
      );
    }
    result = await runProcess(
      executable,
      defaults.args(prompt, sealedWorkspace, emptySkills, promptFile),
      sealedWorkspace,
      remainingMs,
      maximumOutput,
      node.adapter,
      node.adapter === "qoder" ? prompt : undefined
    );
  } finally {
    release?.();
    await rm(sealedRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  if (result.exitCode !== 0) {
    throw new ResearchStewardError(
      "PROVIDER_EXIT_FAILED",
      `${defaults.commandName} exited with ${result.exitCode}.`,
      {
        duration_ms: result.durationMs,
        exit_code: result.exitCode,
        stdout_hash: sha256Text(result.stdout),
        stdout_chars: result.stdout.length,
        stderr_hash: sha256Text(result.stderr),
        stderr_chars: result.stderr.length
      }
    );
  }

  let output: ModelOutput;
  try {
    output = ModelOutputSchema.parse(normalizeModelOutput(extractJsonCandidate(result.stdout)));
  } catch (error) {
    throw new ResearchStewardError(
      "MODEL_OUTPUT_REJECTED",
      "Provider completed, but its output did not satisfy the structured contribution contract.",
      {
        duration_ms: result.durationMs,
        exit_code: result.exitCode,
        stdout_hash: sha256Text(result.stdout),
        stdout_chars: result.stdout.length,
        stderr_hash: sha256Text(result.stderr),
        stderr_chars: result.stderr.length,
        parser_error_code:
          error instanceof ResearchStewardError ? error.code : "MODEL_OUTPUT_SCHEMA_MISMATCH"
      }
    );
  }
  return {
    output,
    adapter: node.adapter,
    model: defaults.model,
    duration_ms: result.durationMs,
    exit_code: result.exitCode,
    stdout_hash: sha256Text(result.stdout),
    stdout_chars: result.stdout.length,
    stderr_hash: sha256Text(result.stderr),
    stderr_chars: result.stderr.length,
    executable_name: path.basename(executable)
  };
}
