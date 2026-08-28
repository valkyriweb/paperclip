import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { LiveEvent, LiveEventType } from "@paperclipai/shared";
import { insertLiveEventOutboxRow, type DbOrTx } from "./domain-event-outbox.js";
import { logger } from "../middleware/logger.js";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/**
 * Sentinel `company_id` for globally-scoped events, and the matching
 * in-process emitter channel key. Named descriptively rather than a bare
 * `"*"` so an ad-hoc `select * from live_event_outbox where company_id = ...`
 * is self-explanatory rather than cryptic; `company_id` stays plain `text`
 * (not a FK to `companies`) precisely because this value is never a real
 * company id.
 */
export const GLOBAL_LIVE_EVENT_COMPANY_ID = "__global__";

let nextEventId = 0;

/**
 * Identifies this process among replicas for outbox authorship
 * (`origin_replica_id`) and fanout-checkpoint durability. Prefers
 * `HOSTNAME`/`POD_NAME` (stable across restarts within the same pod) so a
 * pod restart resumes its fanout checkpoint instead of re-scanning from the
 * current tail every time — `tool-runtime-supervisor.ts` prefers `HOSTNAME`
 * for its own `hostId` the same way, though its fallback differs (a fixed
 * `"local-host"` string, not `POD_NAME` then a random id, since it doesn't
 * need a durable per-restart checkpoint identity the way this does). Falls
 * back to a random id for environments with neither `HOSTNAME` nor
 * `POD_NAME` set (e.g. local dev, tests) — see `deleteStaleFanoutCheckpoints`
 * in `domain-event-outbox.ts` for how the resulting checkpoint-row churn is
 * bounded.
 */
const replicaId =
  process.env.HOSTNAME?.trim() || process.env.POD_NAME?.trim() || `local-${randomUUID()}`;

/** Set once at server startup — see `server/src/index.ts`. Unset in most unit tests, which keep the pre-outbox in-memory-only behavior. */
let outboxDb: Db | null = null;

/**
 * Kill switch for the DURABLE WRITE path (this replica's own outbox
 * inserts), independent of `outboxDb` being configured. Defaults to `true`
 * so a server that never calls `configureLiveEventOutbox` explicitly (most
 * unit tests) keeps the pre-outbox in-memory-only behavior, while a real
 * boot that wires `db` but wants fanout fully off (`PAPERCLIP_LIVE_EVENT_
 * FANOUT_ENABLED=false`) gets a write path that is actually inert, not just
 * a consumer that stops reading rows nobody asked it to stop writing.
 */
let outboxWriteEnabled = true;

export function configureLiveEventOutbox(db: Db, writeEnabled = true) {
  outboxDb = db;
  outboxWriteEnabled = writeEnabled;
}

export function getLiveEventReplicaId(): string {
  return replicaId;
}

/**
 * Event types eligible for durable outbox persistence (cross-replica fanout
 * + at-least-once delivery). Allowlist, not blocklist, by design: adding a
 * new `LiveEventType` must be an explicit decision about whether it's safe
 * and useful to duplicate into a second durable table, not an accidental
 * default.
 *
 * Deliberately excluded: `heartbeat.run.progress` and `heartbeat.run.log`
 * (can carry raw tool stdout/stderr and assistant-output snippets — large,
 * high-frequency, and potentially sensitive; see `buildHeartbeatRunStatus
 * LiveEventPayload` vs. `publishHeartbeatRunRuntimeProgress` in
 * `heartbeat.ts`), `heartbeat.run.event` (free-form per-tool-call event
 * data, same shape of risk), and `plugin.ui.updated` (ephemeral UI-render
 * hint, not a state transition a client must not miss). None of these lose
 * their existing same-process synchronous delivery — only cross-replica
 * durability is withheld.
 */
const OUTBOX_ALLOWED_EVENT_TYPES: ReadonlySet<LiveEventType> = new Set([
  "heartbeat.run.queued",
  "heartbeat.run.status",
  "agent.status",
  "activity.logged",
  "external_object.updated",
  "plugin.worker.crashed",
  "plugin.worker.restarted",
]);

/** Payload keys redacted before a payload is durably written to the outbox, regardless of event type. Defense in depth over the allowlist above, not a substitute for it. */
const OUTBOX_REDACTED_PAYLOAD_KEYS = new Set([
  "token",
  "secret",
  "password",
  "apikey",
  "api_key",
  "authorization",
  "stdout",
  "stderr",
  "output",
  "log",
  "snippet",
]);

/**
 * Depth limit for the recursive redaction walk below. `activity.logged`'s
 * `payload.details` is an arbitrary, producer-supplied nested object (see
 * `activity-log.ts`'s `redactActivityDetails`, which is a domain-level
 * redaction and not a guarantee that a key like `token` can never appear a
 * few levels deep in application-shaped metadata) — a shallow, top-level-only
 * redaction would miss a sensitive key nested inside it. The walk is
 * depth-bounded rather than unbounded so a pathological or adversarial
 * payload cannot force unbounded recursion; anything past the bound is
 * replaced with a marker rather than walked further.
 */
const OUTBOX_REDACTION_MAX_DEPTH = 6;

/**
 * Identity fields preserved verbatim through payload truncation (see
 * `prepareOutboxPayload`) even when the rest of the payload is dropped for
 * being oversized. Without this, a client that only ever sees the truncated
 * marker for an oversized `heartbeat.run.status` event has no `runId` to
 * correlate it with — it can tell *something* happened for this company, but
 * not what. These are the identity keys the outbox-allowlisted event types
 * actually use (see the payload shapes at each `publishLiveEvent`/
 * `publishLiveEventTx` call site for `heartbeat.run.queued`/
 * `heartbeat.run.status`, `agent.status`, `activity.logged`,
 * `external_object.updated`, `plugin.worker.crashed`/`restarted`); `issueId`
 * is included per explicit review requirement even though no current
 * allowlisted payload uses that exact key name, so a future producer that
 * does gets this protection for free.
 */
const OUTBOX_IDENTITY_CORE_KEYS = [
  "runId",
  "agentId",
  "status",
  "issueId",
  "entityId",
  "entityType",
  "objectId",
  "pluginId",
] as const;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > OUTBOX_REDACTION_MAX_DEPTH) return "[redaction depth limit exceeded]";
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      result[key] = OUTBOX_REDACTED_PAYLOAD_KEYS.has(key.toLowerCase())
        ? "[redacted]"
        : redactValue(v, depth + 1);
    }
    return result;
  }
  return value;
}

/** Recursively redacts `OUTBOX_REDACTED_PAYLOAD_KEYS` at any nesting depth up to `OUTBOX_REDACTION_MAX_DEPTH` — see that constant's doc comment for why a shallow, top-level-only walk is not sufficient. */
function redactOutboxPayload(payload: LiveEventPayload): LiveEventPayload {
  return redactValue(payload, 0) as LiveEventPayload;
}

function extractOutboxIdentityCore(payload: LiveEventPayload): LiveEventPayload {
  const core: LiveEventPayload = {};
  for (const key of OUTBOX_IDENTITY_CORE_KEYS) {
    if (payload[key] !== undefined) core[key] = payload[key];
  }
  return core;
}

/**
 * Ceiling on a durably-outboxed payload's JSON size. `heartbeat_runs` and
 * friends are the durable record of truth for large state; this table exists
 * for cross-replica *signal*, not as a second copy of arbitrary application
 * data. A payload over the cap is replaced with a small marker plus the
 * identity core (see `OUTBOX_IDENTITY_CORE_KEYS`) — the event's existence
 * (type, company, timestamp) and *which* run/agent/entity it concerns still
 * fan out, but the rest of its body does not, and a client that needs the
 * full payload should fetch it from the REST API the same way it would after
 * any missed event (delivery is documented at-least-once, not exactly-once).
 *
 * Note: `heartbeat.run.status`'s `finalText` field (see
 * `buildHeartbeatRunStatusLiveEventPayload` in `heartbeat.ts`) is itself a
 * duplicate of content already durable elsewhere — `heartbeat_runs.resultJson`
 * on the run row, and, for issue-linked runs, the same text posted as a
 * GitHub issue comment (`buildHeartbeatRunIssueComment`). It is the most
 * likely field to push a run-status payload over this cap; when that
 * happens, the outbox row loses `finalText` but the identity core above (at
 * minimum `runId`/`agentId`/`status`) survives, and the full text remains
 * available from the run row itself.
 */
const MAX_OUTBOX_PAYLOAD_BYTES = 8192;

function prepareOutboxPayload(payload: LiveEventPayload): LiveEventPayload {
  const redacted = redactOutboxPayload(payload);
  const serialized = JSON.stringify(redacted);
  const sizeBytes = Buffer.byteLength(serialized, "utf8");
  if (sizeBytes <= MAX_OUTBOX_PAYLOAD_BYTES) return redacted;
  return { truncated: true, originalSizeBytes: sizeBytes, ...extractOutboxIdentityCore(redacted) };
}

function isOutboxWriteEligible(type: LiveEventType): boolean {
  return outboxDb !== null && outboxWriteEnabled && OUTBOX_ALLOWED_EVENT_TYPES.has(type);
}

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

function writeOutboxBestEffort(input: { companyId: string; type: LiveEventType; payload: LiveEventPayload }) {
  if (!isOutboxWriteEligible(input.type)) return;
  void insertLiveEventOutboxRow(outboxDb!, {
    companyId: input.companyId,
    type: input.type,
    payload: prepareOutboxPayload(input.payload),
    originReplicaId: replicaId,
  }).catch((err) => {
    logger.error({ err, companyId: input.companyId, type: input.type }, "live event outbox: best-effort insert failed");
  });
}

/**
 * Publishes a company-scoped live event.
 *
 * Delivery has two independent paths, matching plan 005's classification of
 * producers into "transactional state" vs "best-effort signal" (most
 * existing callers are the latter):
 *
 * 1. Local same-process delivery is synchronous and unchanged from before
 *    this slice — every existing caller and test that relies on the event
 *    already having reached `subscribeCompanyLiveEvents` listeners by the
 *    time this function returns keeps working exactly as before. The
 *    client-facing `event.id` is always this process's local monotonic
 *    counter — see `deliverLiveEventLocally` for why that also holds for
 *    events fanned in from other replicas, so a subscriber never sees two
 *    different id spaces interleaved on one stream.
 * 2. A best-effort, fire-and-forget durable outbox row is also written (once
 *    `configureLiveEventOutbox` has run, the write kill switch is on, and
 *    `type` is on the outbox allowlist — see `OUTBOX_ALLOWED_EVENT_TYPES`)
 *    so other replicas' fanout consumers can deliver the same event to
 *    sockets attached to them. This path does not block the caller and is
 *    not atomic with any state write the caller may have just made — see
 *    `publishLiveEventTx` for that guarantee. The outbox row's own id is
 *    never exposed to clients; it exists purely as this table's internal
 *    ordering/cursor key (see `domain-event-outbox.ts`).
 */
export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  emitter.emit(input.companyId, event);
  writeOutboxBestEffort({ companyId: input.companyId, type: input.type, payload: event.payload });
  return event;
}

export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent({ companyId: GLOBAL_LIVE_EVENT_COMPANY_ID, type: input.type, payload: input.payload });
  emitter.emit(GLOBAL_LIVE_EVENT_COMPANY_ID, event);
  writeOutboxBestEffort({ companyId: GLOBAL_LIVE_EVENT_COMPANY_ID, type: input.type, payload: event.payload });
  return event;
}

/**
 * Transactional counterpart to `publishLiveEvent`: writes the outbox row
 * inside the caller's own `db.transaction(async (tx) => ...)` so it commits
 * atomically with whatever state write the transaction also makes — a
 * publisher crash between the state write and this insert cannot happen,
 * because they are the same commit. This is the "committed state" path;
 * reserve it for events that represent a durable state transition a client
 * must never silently miss (currently: heartbeat run status transitions, see
 * `heartbeat.ts`'s `setRunStatus`/`setRunStatusFromLive`).
 *
 * Always returns the `{ companyId, type, payload }` needed to deliver the
 * event locally after commit (see `deliverLiveEventLocally`) — the outbox
 * insert itself is skipped (not an error) when the write kill switch is off
 * or `type` isn't on the outbox allowlist, exactly like
 * `writeOutboxBestEffort`, so a disabled outbox degrades to "no durability",
 * not "no event". Does NOT emit locally itself — the row (when written) is
 * not visible to any reader, including this replica's own fanout consumer,
 * until the transaction commits, so local delivery must happen after commit.
 */
export async function publishLiveEventTx(
  tx: DbOrTx,
  input: { companyId: string; type: LiveEventType; payload?: LiveEventPayload },
): Promise<{ companyId: string; type: LiveEventType; payload: LiveEventPayload }> {
  const payload = input.payload ?? {};
  if (isOutboxWriteEligible(input.type)) {
    await insertLiveEventOutboxRow(tx, {
      companyId: input.companyId,
      type: input.type,
      payload: prepareOutboxPayload(payload),
      originReplicaId: replicaId,
    });
  }
  return { companyId: input.companyId, type: input.type, payload };
}

/**
 * Delivers an event to this replica's local subscribers — used both for this
 * replica's own committed transactional events (after `publishLiveEventTx`'s
 * transaction commits) and for rows another replica's fanout consumer has
 * pulled from the outbox (see `createLiveEventFanoutConsumer`'s `deliver`
 * callback in `server/src/index.ts`, which is wired directly to this
 * function and passes a full `LiveEventOutboxRow`).
 *
 * Always assigns a fresh *local* id via `toLiveEvent`, the same counter
 * `publishLiveEvent` uses, rather than the outbox row's durable id: a
 * subscriber's stream must present one consistent id space, not a mix of
 * this process's counter (best-effort local events) and another table's
 * bigserial (fanned-in/transactional events). The durable id is
 * intentionally never client-facing — see `publishLiveEventTx`.
 */
export function deliverLiveEventLocally(row: {
  companyId: string;
  type: string;
  payload: Record<string, unknown>;
}) {
  const event = toLiveEvent({
    companyId: row.companyId,
    type: row.type as LiveEventType,
    payload: row.payload,
  });
  emitter.emit(event.companyId, event);
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on(GLOBAL_LIVE_EVENT_COMPANY_ID, listener);
  return () => emitter.off(GLOBAL_LIVE_EVENT_COMPANY_ID, listener);
}
