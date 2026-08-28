import { pgTable, text, integer, bigint, bigserial, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * `live_event_outbox` — durable transactional-outbox row for company-scoped
 * (and global, `company_id = "__global__"`) live events (active-active plan
 * 005). Only an explicit allowlist of event types is written here — see
 * `OUTBOX_ALLOWED_EVENT_TYPES` in `live-events.ts` — with payloads capped and
 * redacted before insert (`prepareOutboxPayload`); this table is
 * cross-replica fanout *signal*, not a general-purpose durable event log.
 *
 * The in-memory `EventEmitter` in `live-events.ts` only reaches WebSockets
 * attached to the *same* Node process. This table is the cross-replica
 * source of truth: every replica's fanout consumer polls rows with
 * `id > <its own checkpoint>` and re-delivers them to its own locally
 * attached sockets, so an event published on replica A eventually reaches a
 * socket connected to replica B.
 *
 * `company_id` is plain `text`, not a FK to `companies`, because global
 * events use the sentinel `"__global__"` (`GLOBAL_LIVE_EVENT_COMPANY_ID` in
 * `live-events.ts`, also the in-process emitter channel key) rather than a
 * real company id.
 *
 * `origin_replica_id` lets each replica's fanout consumer skip rows it
 * produced itself — the producing replica already delivered the event to its
 * own sockets synchronously at publish time (unchanged pre-existing
 * behavior), so re-delivering via its own poll would double-send it.
 *
 * `id` is the globally cursorable identifier used for each replica's fanout
 * checkpoint (`live_event_fanout_checkpoints`) and for the insert-ordering
 * guarantee in `insertLiveEventOutboxRow`
 * (`LIVE_EVENT_OUTBOX_INSERT_LOCK_KEY`, `domain-event-outbox.ts`). It is
 * never exposed to WebSocket clients — the client-facing `event.id` is
 * always a per-connection local counter (see `deliverLiveEventLocally`);
 * there is no client-facing reconnect-replay cursor in this slice.
 */
export const liveEventOutbox = pgTable(
  "live_event_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: text("company_id").notNull(),
    type: text("type").notNull(),
    /** Payload schema version, so a future breaking payload shape change is detectable by consumers. */
    schemaVersion: integer("schema_version").notNull().default(1),
    /** Non-secret event payload. Callers must not put credentials/tokens here — see doc/operations/live-event-replay.md. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    originReplicaId: text("origin_replica_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: index("live_event_outbox_company_id_idx").on(table.companyId, table.id),
    createdAtIdx: index("live_event_outbox_created_at_idx").on(table.createdAt),
  }),
);

/**
 * `live_event_fanout_checkpoints` — one row per replica identity
 * (`process.env.HOSTNAME`/`POD_NAME`, see `live-events.ts`), tracking the
 * highest `live_event_outbox.id` that replica's fanout consumer has already
 * processed. Durable so a restarting replica resumes from where it left off
 * instead of either replaying its whole history to freshly (re)connected
 * sockets or silently skipping events published while it was down.
 */
export const liveEventFanoutCheckpoints = pgTable("live_event_fanout_checkpoints", {
  replicaId: text("replica_id").primaryKey(),
  lastDeliveredId: bigint("last_delivered_id", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
