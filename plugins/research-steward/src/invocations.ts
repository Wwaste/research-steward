import { createHash } from "node:crypto";
import { z } from "zod";
import { FailureClassSchema, type FailureClass } from "./provider-failure.js";
import { IdentifierSchema, type CommittedEvent } from "./protocol.js";
import { ResearchStewardError } from "./utils.js";

/**
 * Invocation state is a fold over the immutable event ledger
 * (DESIGN-INVOCATION-LEDGER). This module does not own storage: callers
 * append protocol events, then fold them here. CR-M-050/051/052.
 */

export const INVOCATION_FOLD_STATES = [
  "started",
  "cancel_requested",
  "finished_ok",
  "finished_failed",
  "cancelled",
  "unknown"
] as const;

export type InvocationFoldState = (typeof INVOCATION_FOLD_STATES)[number];

export const InvocationSnapshotSchema = z
  .object({
    invocation_id: z.string().regex(/^[a-f0-9]{32}$/),
    run_id: IdentifierSchema,
    node_id: IdentifierSchema,
    attempt: z.number().int().min(1),
    adapter: z.string().min(1).max(64),
    model: z.string().min(1).max(100).optional(),
    state: z.enum(INVOCATION_FOLD_STATES),
    failure_class: FailureClassSchema.nullable().default(null),
    stdout_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
    replay_authorized: z.boolean().default(false),
    prior_state: z.enum(["started", "cancel_requested"]).nullable().default(null)
  })
  .strict();

export type InvocationSnapshot = z.infer<typeof InvocationSnapshotSchema>;

export function makeInvocationId(
  run_id: string,
  node_id: string,
  attempt: number
): string {
  IdentifierSchema.parse(run_id);
  IdentifierSchema.parse(node_id);
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new ResearchStewardError(
      "INVALID_INVOCATION_ATTEMPT",
      "attempt must be a 1-based integer"
    );
  }
  // Newline separator + IdentifierSchema charset (no | or newline) prevents
  // concatenation collisions (CR-M-052).
  return createHash("sha256")
    .update(`${run_id}\n${node_id}\n${attempt}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function metadataOf(event: CommittedEvent): Record<string, unknown> {
  return (event.metadata ?? {}) as Record<string, unknown>;
}

function strField(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Fold invocation_* events into per-invocation snapshots.
 * Later events win; illegal orders are ignored at fold time and must be
 * rejected at append time.
 */
export function foldInvocations(
  events: readonly CommittedEvent[]
): Map<string, InvocationSnapshot> {
  const map = new Map<string, InvocationSnapshot>();
  for (const event of events) {
    const meta = metadataOf(event);
    const id = strField(meta, "invocation_id");
    if (id === undefined) continue;
    const existing = map.get(id);
    switch (event.type) {
      case "invocation_started": {
        // CR-M-067: a new started event must not overwrite an existing
        // terminal or unknown record (would erase incident evidence).
        if (
          existing &&
          (existing.state === "unknown" ||
            existing.state === "finished_ok" ||
            existing.state === "finished_failed" ||
            existing.state === "cancelled")
        ) {
          break;
        }
        map.set(
          id,
          InvocationSnapshotSchema.parse({
            invocation_id: id,
            run_id: strField(meta, "run_id") ?? event.run_id ?? "run",
            node_id: strField(meta, "node_id") ?? "node",
            attempt: typeof meta["attempt"] === "number" ? meta["attempt"] : 1,
            adapter: strField(meta, "adapter") ?? "unknown",
            model: strField(meta, "model"),
            state: "started",
            failure_class: null,
            stdout_sha256: null,
            replay_authorized: false,
            prior_state: null
          })
        );
        break;
      }
      case "invocation_finished": {
        if (!existing) break;
        const status = strField(meta, "status") === "ok" ? "ok" : "failed";
        map.set(id, {
          ...existing,
          state: status === "ok" ? "finished_ok" : "finished_failed",
          failure_class:
            status === "ok"
              ? null
              : FailureClassSchema.parse(strField(meta, "failure_class") ?? "unknown"),
          stdout_sha256: strField(meta, "stdout_sha256") ?? null
        });
        break;
      }
      case "invocation_cancel_requested": {
        if (!existing || existing.state !== "started") break;
        map.set(id, { ...existing, state: "cancel_requested" });
        break;
      }
      case "invocation_cancelled": {
        if (!existing) break;
        if (existing.state === "finished_ok" || existing.state === "finished_failed") break;
        map.set(id, { ...existing, state: "cancelled", failure_class: "cancelled" });
        break;
      }
      case "invocation_unknown": {
        if (!existing) break;
        if (
          existing.state === "finished_ok" ||
          existing.state === "finished_failed" ||
          existing.state === "cancelled"
        ) {
          break;
        }
        map.set(id, {
          ...existing,
          state: "unknown",
          prior_state: existing.state as "started" | "cancel_requested"
        });
        break;
      }
      case "invocation_replay_authorized": {
        if (!existing || existing.state !== "unknown") break;
        map.set(id, { ...existing, replay_authorized: true });
        break;
      }
      default:
        break;
    }
  }
  return map;
}

/** CR-M-051: unknown is immutable except via replay_authorized + new attempt. */
export function assertCancellable(state: InvocationFoldState): void {
  if (state === "unknown") {
    throw new ResearchStewardError(
      "INVOCATION_OUTCOME_UNKNOWN",
      "An unknown invocation may already have completed a paid call; cancel is not allowed. " +
        "Authorize replay explicitly or leave it unknown."
    );
  }
  if (state === "finished_ok" || state === "finished_failed" || state === "cancelled") {
    throw new ResearchStewardError(
      "INVOCATION_ALREADY_TERMINAL",
      `Invocation is already ${state}.`
    );
  }
}

export function allowsAutoReplay(
  snapshot: InvocationSnapshot,
  opts: { resume_policy: "never" | "fake_only" | "explicit" }
): boolean {
  if (snapshot.state !== "unknown") return false;
  if (opts.resume_policy === "never") return false;
  if (opts.resume_policy === "fake_only") return snapshot.adapter === "fake";
  // explicit: only with a human authorization event
  return snapshot.replay_authorized;
}

export function isTerminal(state: InvocationFoldState): boolean {
  return (
    state === "finished_ok" ||
    state === "finished_failed" ||
    state === "cancelled"
  );
}
