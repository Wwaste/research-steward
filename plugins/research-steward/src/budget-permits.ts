import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  resolvePrivateDestinationInside,
  resolvePrivateExistingInside
} from "./paths.js";
import { ResearchStewardError, sha256Text } from "./utils.js";
import type { CommittedEvent } from "./protocol.js";

/**
 * Provider permits use directory-lease slot semantics
 * (DESIGN-BUDGET-PERMITS / CR-M-053..055). Rename is the tie-break; no
 * insert-then-count self-delete race.
 */

export interface PermitSlotOptions {
  runtimeRoot: string;
  provider: string;
  maxConcurrent: number;
  staleMs?: number;
  heartbeatMs?: number;
  attempts?: number;
  waitMs?: number;
}

export interface PermitHandle {
  slot: number;
  token: string;
  release: () => Promise<void>;
}

const DEFAULT_STALE_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function providerPermitDir(
  runtimeRoot: string,
  provider: string
): Promise<string> {
  // provider is validated as a relative path component (CR-M-055).
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(provider)) {
    throw new ResearchStewardError(
      "INVALID_PROVIDER_NAME",
      "Provider name must be a simple identifier."
    );
  }
  const dir = path.join(runtimeRoot, "permits", provider);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function acquirePermitSlot(
  options: PermitSlotOptions
): Promise<PermitHandle> {
  if (options.maxConcurrent < 1) {
    throw new ResearchStewardError("INVALID_PERMIT_LIMIT", "maxConcurrent must be >= 1");
  }
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const attempts = options.attempts ?? 8;
  const waitMs = options.waitMs ?? 25;
  const dir = await providerPermitDir(options.runtimeRoot, options.provider);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (let slot = 0; slot < options.maxConcurrent; slot += 1) {
      const leasePath = path.join(dir, `slot-${slot}`);
      const token = randomUUID();
      const candidate = path.join(dir, `candidate-slot-${slot}-${token}`);
      await mkdir(candidate, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(candidate, "owner.json"),
        `${JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() })}\n`,
        { mode: 0o600 }
      );
      try {
        await rename(candidate, leasePath);
        return {
          slot,
          token,
          release: async () => {
            try {
              const owner = JSON.parse(
                await (await import("node:fs/promises")).readFile(
                  path.join(leasePath, "owner.json"),
                  "utf8"
                )
              ) as { token?: string };
              if (owner.token === token) {
                await rm(leasePath, { recursive: true, force: true });
              }
            } catch {
              // already gone
            }
          }
        };
      } catch {
        await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
        // try stale reclaim
        try {
          const info = await stat(leasePath);
          if (Date.now() - info.mtimeMs > staleMs) {
            const quarantine = path.join(dir, `stale-slot-${slot}-${randomUUID()}`);
            await rename(leasePath, quarantine);
            const ownerPath = path.join(quarantine, "owner.json");
            const raw = await (await import("node:fs/promises"))
              .readFile(ownerPath, "utf8")
              .catch(() => "{}");
            const owner = JSON.parse(raw) as { token?: string };
            if (typeof owner.token === "string") {
              await rm(quarantine, { recursive: true, force: true });
            }
          }
        } catch {
          // ENOENT race — retry loop
        }
      }
    }
    await sleep(waitMs);
  }
  throw new ResearchStewardError(
    "PERMIT_EXHAUSTED",
    `No free permit slot for ${options.provider} after ${attempts} attempts.`,
    { provider: options.provider, max_concurrent: options.maxConcurrent }
  );
}

/**
 * Budget used count is folded from invocation_started events for paid
 * adapters inside the window. There is no second counter.
 */
export function countPaidInvocationsInWindow(
  events: readonly CommittedEvent[],
  windowStartIso: string,
  paidAdapters: readonly string[] = ["kimi", "qoder", "grok"]
): number {
  const start = Date.parse(windowStartIso);
  let n = 0;
  for (const event of events) {
    if (event.type !== "invocation_started") continue;
    const adapter = event.metadata["adapter"];
    if (typeof adapter !== "string" || !paidAdapters.includes(adapter)) continue;
    // CR-M-068: CommittedEvent production field is timestamp, not created_at.
    const ts = (event as { timestamp?: string }).timestamp;
    if (typeof ts === "string" && Date.parse(ts) >= start) n += 1;
  }
  return n;
}

export function assertBudgetAllowsFromLedger(input: {
  events: readonly CommittedEvent[];
  window_start: string;
  max_invocations: number;
  provider: string;
  /** CR-M-072: permit credential proving the caller holds a slot. */
  permit_token?: string;
}): void {
  if (input.permit_token === undefined || input.permit_token === "") {
    throw new ResearchStewardError(
      "PERMIT_REQUIRED",
      "Budget checks require a held permit token."
    );
  }
  const used = countPaidInvocationsInWindow(
    input.events,
    input.window_start,
    [input.provider]
  );
  if (used >= input.max_invocations) {
    throw new ResearchStewardError(
      "BUDGET_EXCEEDED",
      `Provider ${input.provider} budget exhausted for this window.`,
      { provider: input.provider, used, max: input.max_invocations }
    );
  }
}

export function permitContentToken(token: string): string {
  return sha256Text(token);
}
