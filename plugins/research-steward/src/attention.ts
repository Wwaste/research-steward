import { projectSummary } from "./store.js";
import { sha256Text, stableJson } from "./utils.js";

export interface AttentionItem {
  kind: "human_review" | "blocker";
  id: string;
  summary: string;
}

export interface AttentionDigest {
  digest_hash: string;
  items: AttentionItem[];
}

export interface NotifyOptions {
  notifier?: (title: string, body: string) => Promise<void>;
  quietHours?: { start: number; end: number };
  now?: Date;
  enabled?: boolean;
}

export interface NotifyResult {
  attempted: boolean;
  delivered: boolean;
  reason?: string;
}

export interface RecordedNotification {
  title: string;
  body: string;
  recorded_at: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export async function buildAttentionDigest(root: string): Promise<AttentionDigest> {
  const summary = await projectSummary(root);
  const items: AttentionItem[] = [];
  const humanReview = asRecord(summary["human_review"]);
  if (humanReview) {
    if (humanReview["status"] === "reverification_required") {
      const id = asString(humanReview["superseded_verification_event_id"]);
      const invalidators = Array.isArray(humanReview["invalidating_event_ids"])
        ? humanReview["invalidating_event_ids"].length
        : 0;
      items.push({
        kind: "human_review",
        id,
        summary: `Verification ${id} was superseded by ${invalidators} later protocol event(s); run verify again before human review.`
      });
    } else {
      const id = asString(humanReview["verification_event_id"]);
      items.push({
        kind: "human_review",
        id,
        summary: `Verification ${id} passed and is awaiting named human confirmation in ACCEPTANCE.yaml.`
      });
    }
  }
  const blockers = Array.isArray(summary["unresolved_blockers"])
    ? summary["unresolved_blockers"]
    : [];
  for (const raw of blockers) {
    const blocker = asRecord(raw);
    if (!blocker) continue;
    const id = asString(blocker["event_id"]);
    const actor = asString(blocker["actor_id"], "an unknown actor");
    const timestamp = asString(blocker["timestamp"], "an unknown time");
    items.push({
      kind: "blocker",
      id,
      summary: `Event ${id} raised by ${actor} at ${timestamp} is still blocked and waiting for explicit resolution.`
    });
  }
  return { digest_hash: sha256Text(stableJson(items)), items };
}

export function shouldNotify(
  previousHash: string | undefined,
  digest: AttentionDigest
): boolean {
  return previousHash !== digest.digest_hash;
}

const MAX_RECORDED_NOTIFICATIONS = 50;
const recordedNotifications: RecordedNotification[] = [];

// The default notifier is a local no-op recorder: it keeps a small in-memory
// log for diagnostics and never talks to any external notification service.
async function defaultNotifier(title: string, body: string): Promise<void> {
  recordedNotifications.push({ title, body, recorded_at: new Date().toISOString() });
  if (recordedNotifications.length > MAX_RECORDED_NOTIFICATIONS) {
    recordedNotifications.splice(
      0,
      recordedNotifications.length - MAX_RECORDED_NOTIFICATIONS
    );
  }
}

export function localNotificationLog(): readonly RecordedNotification[] {
  return [...recordedNotifications];
}

function normalizeHour(value: number): number {
  const truncated = Number.isFinite(value) ? Math.trunc(value) : 0;
  return ((truncated % 24) + 24) % 24;
}

function inQuietHours(hour: number, quietHours: { start: number; end: number }): boolean {
  const start = normalizeHour(quietHours.start);
  const end = normalizeHour(quietHours.end);
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  // The window crosses midnight, e.g. { start: 22, end: 6 }.
  return hour >= start || hour < end;
}

export async function notifyLocal(
  digest: AttentionDigest,
  options: NotifyOptions = {}
): Promise<NotifyResult> {
  // Notification is best-effort diagnostics only: this function never throws
  // and never appends anything to the project ledger.
  try {
    if (options.enabled === false) {
      return { attempted: false, delivered: false, reason: "disabled" };
    }
    const now = options.now ?? new Date();
    if (options.quietHours && inQuietHours(now.getHours(), options.quietHours)) {
      return { attempted: false, delivered: false, reason: "quiet-hours" };
    }
    const notifier = options.notifier ?? defaultNotifier;
    const title =
      digest.items.length === 0
        ? "Research Steward: nothing is waiting on you"
        : `Research Steward: ${digest.items.length} item(s) need human attention`;
    try {
      await notifier(title, wakeSummary(digest));
      return { attempted: true, delivered: true };
    } catch {
      return { attempted: true, delivered: false, reason: "notifier-failed" };
    }
  } catch {
    return { attempted: false, delivered: false, reason: "notifier-failed" };
  }
}

export function wakeSummary(digest: AttentionDigest): string {
  if (digest.items.length === 0) {
    return "Nothing is waiting on you right now: no verification awaits human confirmation and no blocker is unresolved.";
  }
  const parts = digest.items.map(
    (item, index) => `${index + 1}) [${item.kind}] ${item.id}: ${item.summary}`
  );
  return `First thing after waking up: ${digest.items.length} item(s) need your attention. ${parts.join(
    " "
  )} See HUMAN_REVIEW_QUEUE.md in the project root for full context.`;
}
