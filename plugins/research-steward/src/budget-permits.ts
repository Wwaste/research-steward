import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ResearchStewardError } from "./utils.js";

/**
 * Cross-process provider budget permits (Task 2.3, module layer). Uses
 * generation-fenced directory leases under a runtime dir — not project event
 * locks. Stores no credentials.
 */

export interface PermitOptions {
  runtimeDir: string;
  provider: string;
  maxConcurrent: number;
  staleMs?: number;
}

function permitDir(options: PermitOptions): string {
  return path.join(options.runtimeDir, "permits", options.provider);
}

export async function acquirePermit(options: PermitOptions): Promise<{
  release: () => Promise<void>;
  token: string;
}> {
  if (options.maxConcurrent < 1) {
    throw new ResearchStewardError("INVALID_PERMIT_LIMIT", "maxConcurrent must be >= 1");
  }
  const dir = permitDir(options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const token = createHash("sha256")
    .update(`${process.pid}|${Date.now()}|${Math.random()}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  const candidate = path.join(dir, `candidate-${token}`);
  const lease = path.join(dir, `lease-${token}`);
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(candidate, "owner.json"),
    `${JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })}\n`,
    { mode: 0o600 }
  );
  await rename(candidate, lease);

  // Enforce max by counting live leases (best-effort; stale reclaim).
  const { readdir, stat } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  const staleMs = options.staleMs ?? 60_000;
  let live = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("lease-")) continue;
    const info = await stat(path.join(dir, entry.name));
    if (Date.now() - info.mtimeMs > staleMs) {
      await rm(path.join(dir, entry.name), { recursive: true, force: true });
      continue;
    }
    live += 1;
  }
  if (live > options.maxConcurrent) {
    await rm(lease, { recursive: true, force: true });
    throw new ResearchStewardError(
      "PERMIT_EXHAUSTED",
      `Provider ${options.provider} is at its concurrency limit (${options.maxConcurrent}).`,
      { provider: options.provider, live }
    );
  }

  return {
    token,
    release: async () => {
      await rm(lease, { recursive: true, force: true });
    }
  };
}

export interface BudgetWindow {
  provider: string;
  window_start: string;
  max_invocations: number;
  used: number;
}

export function remainingBudget(window: BudgetWindow): number {
  return Math.max(0, window.max_invocations - window.used);
}

export function assertBudgetAllows(window: BudgetWindow, n = 1): void {
  if (remainingBudget(window) < n) {
    throw new ResearchStewardError(
      "BUDGET_EXCEEDED",
      `Provider ${window.provider} budget exhausted for this window.`,
      { provider: window.provider, remaining: remainingBudget(window) }
    );
  }
}
