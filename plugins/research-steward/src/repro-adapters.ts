import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ResearchStewardError } from "./utils.js";

/**
 * Optional reproducibility tool adapters (Task 3.8). Each adapter only
 * *detects* version and artifact identity. It never executes analysis
 * commands — that requires Task 3.4 policy. Missing tools are zero noise.
 */

export const ADAPTER_IDS = ["dvc", "marimo", "quarto", "great_expectations"] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

export const AdapterProbeSchema = z
  .object({
    adapter: z.enum(ADAPTER_IDS),
    available: z.boolean(),
    version: z.string().max(200).optional(),
    identity: z.string().max(500).optional(),
    detail: z.string().max(2_000).optional()
  })
  .strict();

export type AdapterProbe = z.infer<typeof AdapterProbeSchema>;

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function readIfExists(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

/** DVC: dvc.yaml + dvc.lock identity; no `dvc` process spawn. */
export async function probeDvc(projectRoot: string): Promise<AdapterProbe> {
  const yamlPath = path.join(projectRoot, "dvc.yaml");
  const lockPath = path.join(projectRoot, "dvc.lock");
  if (!(await isFile(yamlPath)) && !(await isFile(lockPath))) {
    return { adapter: "dvc", available: false };
  }
  const lock = await readIfExists(lockPath);
  return {
    adapter: "dvc",
    available: true,
    version: undefined,
    identity: lock === undefined ? "dvc.yaml-only" : `dvc.lock:${lock.length}`,
    detail: "dvc.yaml/dvc.lock present; stage hashes not parsed in module layer"
  };
}

/** marimo: notebook *.py with marimo metadata. */
export async function probeMarimo(projectRoot: string): Promise<AdapterProbe> {
  const { readdir } = await import("node:fs/promises");
  let entries: string[] = [];
  try {
    entries = await readdir(projectRoot);
  } catch {
    return { adapter: "marimo", available: false };
  }
  for (const name of entries) {
    if (!name.endsWith(".py")) continue;
    const text = await readIfExists(path.join(projectRoot, name));
    if (text !== undefined && text.includes("marimo")) {
      return {
        adapter: "marimo",
        available: true,
        identity: `notebook:${name}`,
        detail: "marimo notebook detected by source marker"
      };
    }
  }
  return { adapter: "marimo", available: false };
}

/** Quarto: _quarto.yml or *.qmd. */
export async function probeQuarto(projectRoot: string): Promise<AdapterProbe> {
  if (await exists(path.join(projectRoot, "_quarto.yml"))) {
    return {
      adapter: "quarto",
      available: true,
      identity: "_quarto.yml",
      detail: "Quarto project config present"
    };
  }
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(projectRoot);
    const qmd = entries.find((name) => name.endsWith(".qmd"));
    if (qmd !== undefined) {
      return { adapter: "quarto", available: true, identity: `qmd:${qmd}` };
    }
  } catch {
    // unreadable root: treat as unavailable, no warning noise
  }
  return { adapter: "quarto", available: false };
}

/** Great Expectations: great_expectations/ or expectations/*.json. */
export async function probeGreatExpectations(
  projectRoot: string
): Promise<AdapterProbe> {
  if (await exists(path.join(projectRoot, "great_expectations"))) {
    return {
      adapter: "great_expectations",
      available: true,
      identity: "great_expectations/",
      detail: "GE directory present; suite results not executed here"
    };
  }
  if (await exists(path.join(projectRoot, "expectations"))) {
    return {
      adapter: "great_expectations",
      available: true,
      identity: "expectations/",
      detail: "expectations/ present without full GE project"
    };
  }
  return { adapter: "great_expectations", available: false };
}

export async function probeAllAdapters(projectRoot: string): Promise<AdapterProbe[]> {
  const results = await Promise.all([
    probeDvc(projectRoot),
    probeMarimo(projectRoot),
    probeQuarto(projectRoot),
    probeGreatExpectations(projectRoot)
  ]);
  return results;
}

/**
 * A missing optional tool is never a scientific failure — only an explicit
 * "required adapter unavailable" when the contract demanded it.
 */
export function assertRequiredAdapter(
  probes: readonly AdapterProbe[],
  required: AdapterId
): void {
  const probe = probes.find((entry) => entry.adapter === required);
  if (probe === undefined || !probe.available) {
    throw new ResearchStewardError(
      "OPTIONAL_ADAPTER_UNAVAILABLE",
      `Required reproducibility adapter "${required}" is not available in this project.`,
      { adapter: required }
    );
  }
}
