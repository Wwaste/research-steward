import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

export class ResearchStewardError extends Error {
  public readonly code: string;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = "ResearchStewardError";
    this.code = code;
    this.details = details;
  }
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .filter((key) => input[key] !== undefined)
        .map((key) => [key, canonicalize(input[key])])
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncParentDirectory(destination: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path.dirname(destination), "r");
  try {
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

export async function atomicWriteFile(
  destination: string,
  contents: string | Uint8Array,
  mode = 0o600
): Promise<void> {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`
  );
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    await rename(temporary, destination);
    await syncParentDirectory(destination);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeImmutableFile(
  destination: string,
  contents: string | Uint8Array,
  mode = 0o600
): Promise<void> {
  const handle = await open(destination, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncParentDirectory(destination);
}

export function assertNever(value: never): never {
  throw new ResearchStewardError("UNEXPECTED_VARIANT", `Unexpected variant: ${String(value)}`);
}

export function bounded(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n[truncated by Research Steward]`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
