import path from "node:path";
import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { MAX_PATH_LENGTH } from "./protocol.js";
import { ResearchStewardError } from "./utils.js";

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export class RootPolicy {
  private roots: string[] = [];
  private rootLoader: (() => Promise<void>) | undefined;
  private rootLoading: Promise<void> | undefined;

  public setRootLoader(loader: () => Promise<void>): void {
    this.rootLoader = loader;
    this.rootLoading = undefined;
  }

  public async prepareRoots(): Promise<void> {
    if (this.roots.length > 0 || this.rootLoader === undefined) return;
    if (this.rootLoading === undefined) {
      this.rootLoading = this.rootLoader().catch((error: unknown) => {
        this.rootLoading = undefined;
        throw error;
      });
    }
    await this.rootLoading;
  }

  public async setRoots(rawRoots: readonly string[]): Promise<void> {
    const resolved: string[] = [];
    for (const raw of rawRoots) {
      const absolute = await realpath(path.resolve(raw));
      const info = await stat(absolute);
      if (!info.isDirectory()) {
        throw new ResearchStewardError("ROOT_NOT_DIRECTORY", `Allowed root is not a directory: ${raw}`);
      }
      resolved.push(absolute);
    }
    this.roots = [...new Set(resolved)];
  }

  public listRoots(): readonly string[] {
    return this.roots;
  }

  public async resolveProject(rawProjectRoot: string): Promise<string> {
    await this.prepareRoots();
    if (rawProjectRoot.length > MAX_PATH_LENGTH || rawProjectRoot.includes("\0")) {
      throw new ResearchStewardError("INVALID_PATH", "Project path is invalid or too long.");
    }
    const resolved = await realpath(path.resolve(rawProjectRoot));
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new ResearchStewardError("PROJECT_NOT_DIRECTORY", "Project root must be a directory.");
    }
    if (this.roots.length === 0) {
      throw new ResearchStewardError(
        "NO_ALLOWED_ROOTS",
        "No filesystem roots were granted. Configure RESEARCH_STEWARD_ROOTS or use an MCP client that supplies roots."
      );
    }
    if (!this.roots.some((root) => inside(root, resolved))) {
      throw new ResearchStewardError("PATH_OUTSIDE_ROOT", "Project root is outside the granted filesystem roots.");
    }
    return resolved;
  }
}

export async function resolveExistingInside(root: string, relativePath: string): Promise<string> {
  validateRelativePath(relativePath);
  const candidate = await realpath(path.resolve(root, relativePath));
  if (!inside(root, candidate)) {
    throw new ResearchStewardError("PATH_ESCAPE", `Path escapes project root: ${relativePath}`);
  }
  return candidate;
}

export async function resolveDestinationInside(root: string, relativePath: string): Promise<string> {
  validateRelativePath(relativePath);
  const absolute = path.resolve(root, relativePath);
  if (!inside(root, absolute)) {
    throw new ResearchStewardError("PATH_ESCAPE", `Path escapes project root: ${relativePath}`);
  }
  const parentReal = await realpath(path.dirname(absolute));
  if (!inside(root, parentReal)) {
    throw new ResearchStewardError("PATH_ESCAPE", `Parent path escapes project root: ${relativePath}`);
  }
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      const target = await realpath(absolute);
      if (!inside(root, target)) {
        throw new ResearchStewardError("SYMLINK_ESCAPE", `Symlink escapes project root: ${relativePath}`);
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  return absolute;
}

async function canonicalPrivateTarget(root: string, relativePath: string): Promise<{
  root: string;
  absolute: string;
  components: string[];
}> {
  validateRelativePath(relativePath);
  const canonicalRoot = await realpath(path.resolve(root));
  const absolute = path.resolve(canonicalRoot, relativePath);
  if (!inside(canonicalRoot, absolute)) {
    throw new ResearchStewardError("PATH_ESCAPE", `Path escapes project root: ${relativePath}`);
  }
  return {
    root: canonicalRoot,
    absolute,
    components: path.relative(canonicalRoot, absolute).split(path.sep).filter(Boolean)
  };
}

async function rejectSymlinkComponents(
  root: string,
  components: readonly string[],
  relativePath: string
): Promise<string> {
  let current = root;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new ResearchStewardError(
        "SYMLINK_COMPONENT",
        `Protected path contains a symbolic link: ${relativePath}`
      );
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new ResearchStewardError(
        "PATH_COMPONENT_NOT_DIRECTORY",
        `Protected path has a non-directory component: ${relativePath}`
      );
    }
  }
  return current;
}

/**
 * Resolve an existing protocol-owned path while rejecting every symlink
 * component. Protocol state is stricter than ordinary research inputs: even a
 * symlink whose target remains inside the project can silently change identity.
 */
export async function resolvePrivateExistingInside(
  root: string,
  relativePath: string
): Promise<string> {
  const target = await canonicalPrivateTarget(root, relativePath);
  await rejectSymlinkComponents(target.root, target.components, relativePath);
  return target.absolute;
}

/** Resolve a protocol-owned output whose parent already exists and is link-free. */
export async function resolvePrivateDestinationInside(
  root: string,
  relativePath: string
): Promise<string> {
  const target = await canonicalPrivateTarget(root, relativePath);
  const parentComponents = target.components.slice(0, -1);
  await rejectSymlinkComponents(target.root, parentComponents, relativePath);
  try {
    const leaf = await lstat(target.absolute);
    if (leaf.isSymbolicLink()) {
      throw new ResearchStewardError(
        "SYMLINK_COMPONENT",
        `Protected destination is a symbolic link: ${relativePath}`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target.absolute;
}

/** Create a protocol-owned directory one component at a time, never following links. */
export async function ensurePrivateDirectoryInside(
  root: string,
  relativePath: string
): Promise<string> {
  const target = await canonicalPrivateTarget(root, relativePath);
  let current = target.root;
  for (const component of target.components) {
    current = path.join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new ResearchStewardError(
        "SYMLINK_COMPONENT",
        `Protected directory contains a symbolic link: ${relativePath}`
      );
    }
    if (!info.isDirectory()) {
      throw new ResearchStewardError(
        "PATH_COMPONENT_NOT_DIRECTORY",
        `Protected directory path is not a directory: ${relativePath}`
      );
    }
  }
  return target.absolute;
}

export function validateRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.length > MAX_PATH_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(relativePath) ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.includes("\\")
  ) {
    throw new ResearchStewardError("INVALID_PATH", `Expected a bounded relative path: ${relativePath}`);
  }
  const components = relativePath.split("/");
  if (components.includes("..")) {
    throw new ResearchStewardError("PATH_ESCAPE", `Path escapes project root: ${relativePath}`);
  }
  if (components.some((component) => component === "" || component === ".")) {
    throw new ResearchStewardError("INVALID_PATH", `Expected a canonical relative path: ${relativePath}`);
  }
  const normalized = path.normalize(relativePath);
  if (
    normalized !== relativePath ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new ResearchStewardError("PATH_ESCAPE", `Path escapes project root: ${relativePath}`);
  }
}

export function assertNonSensitiveArtifactPath(
  relativePath: string,
  action: "freeze" | "package"
): void {
  validateRelativePath(relativePath);
  const lower = relativePath.toLowerCase().split(path.sep).join("/");
  const base = path.basename(lower);
  const explicitSensitiveBase = [
    /^\.env(?:\.|$)/,
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/,
    /^(?:credential|credentials|secret|secrets|token|tokens)(?:\.[^.]+)?$/,
    /^(?:(?:api|auth|access|refresh|private|client|service)[._-](?:token|secret|key|credentials?)|(?:token|secret|key|credentials?)[._-](?:api|auth|access|refresh|private|client|service))(?:\.[^.]+)?$/,
    /\.pem$/,
    /\.p12$/,
    /\.key$/,
    /^\.(?:npmrc|netrc|pypirc|git-credentials)$/,
    /^(?:auth|session)\.json$/
  ];
  if (
    explicitSensitiveBase.some((pattern) => pattern.test(base)) ||
    /(^|\/)\.(?:ssh|aws|azure|config\/gcloud)(\/|$)/.test(lower) ||
    /(^|\/)(?:credentials|secrets|tokens)(\/|$)/.test(lower)
  ) {
    throw new ResearchStewardError(
      "SENSITIVE_FILE",
      `Refusing to ${action} likely credential file: ${relativePath}`
    );
  }
}

export async function findExecutable(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next explicit path.
    }
  }
  return undefined;
}
