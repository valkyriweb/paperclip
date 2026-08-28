# Durable event outbox + cross-replica fanout (active-active plan 005)

## What this is

Live events (`server/src/services/live-events.ts`) were purely in-memory: an
`EventEmitter` per process, fed by a synchronous `nextEventId` counter. That
is invisible to any second Paperclip process, and a publisher that emits an
event then crashes before it reaches every reader loses that event
permanently — nothing durable ever recorded it.

Slice 005 adds a durable, append-only outbox table plus a per-replica
polling fanout consumer:

| Table | Meaning |
|---|---|
| `live_event_outbox` | Append-only row per published event: `id` (bigserial, globally ordered — see "Insert ordering" below), `company_id` (`GLOBAL_LIVE_EVENT_COMPANY_ID`, i.e. `"__global__"`, for global events), `type`, `schema_version`, `payload` (jsonb, capped/redacted — see "What gets durably written" below), `origin_replica_id`, `created_at`. Indexed on `(company_id, id)` and on `created_at` for retention. |
| `live_event_fanout_checkpoints` | One row per replica id: `last_delivered_id`, `updated_at`. The durable cursor a replica's fanout consumer resumes from after a restart. Bounded by the retention sweep — see "Retention" below. |

Migration: `packages/db/src/migrations/0219_big_boomerang.sql`.

Core module: `server/src/services/domain-event-outbox.ts`. Producer-facing
API: `server/src/services/live-events.ts`.

## Insert ordering — the advisory-lock fix

PostgreSQL `bigserial`/`nextval()` allocates ids in call order, but COMMIT
order can differ: a transaction that allocates a lower id can commit *after*
one that allocated a higher id (e.g. it does more work before committing, or
is delayed by contention). A poller doing `WHERE id > cursor ORDER BY id`
with `checkpoint = max(id seen)` is vulnerable to this — if it polls between
the two commits, it advances its checkpoint past the higher id, and the
lower-id row that commits moments later is **permanently skipped**: it will
never again satisfy `id > checkpoint`.

`insertLiveEventOutboxRow` (`domain-event-outbox.ts`) closes this by
acquiring `pg_advisory_xact_lock(hashtext(LIVE_EVENT_OUTBOX_INSERT_LOCK_KEY))`
as the very first statement of its own transaction, before the `INSERT`.
This is PostgreSQL's session-level transactional advisory lock: it is held
until the enclosing transaction commits or rolls back, and serializes every
outbox insert across the whole database — so id-allocation order and commit
order are now guaranteed to agree, closing the gap above. The function
always calls `dbOrTx.transaction(...)` itself, whether `dbOrTx` is a plain
`Db` or an already-open `tx`: the lock is scoped to the *top-level*
transaction regardless of Drizzle savepoint nesting, so this is safe to call
from inside another caller's transaction (the transactional tier, below)
without creating a second, independent transaction.

Covered by `domain-event-outbox.test.ts`'s "held-transaction regression"
test, which manually holds one transaction open (via a reserved raw
`postgres.js` connection, since Drizzle's callback-based `db.transaction()`
cannot hold a transaction open across independently-scheduled operations)
while a second, concurrent `insertLiveEventOutboxRow` call is in flight —
proving the second insert genuinely blocks on the lock (not just
"coincidentally slower"), and that both a fresh poller and delivery order
end up strictly consistent with commit order.

### Lock ordering invariant — outbox lock last, no row locks after it

`LIVE_EVENT_OUTBOX_INSERT_LOCK_KEY` is a single *global* advisory-lock key
(not per-company, not per-row), so every concurrent outbox writer across the
whole process serializes on it, regardless of company. Two rules callers must
follow as a result:

1. **Acquire it last.** A transactional-tier caller (e.g. `heartbeat.ts`'s
   `setRunStatus`/`setRunStatusFromLive`) must take its own row locks (e.g.
   `UPDATE heartbeat_runs ... WHERE id = ...`) *before* calling
   `publishLiveEventTx`, never after. Acquiring the global advisory lock
   first and only then locking rows would queue every other outbox writer in
   the system behind that row work too, and risks deadlock against a
   concurrent transaction that takes the same locks in the opposite order.
2. **Take no further row locks afterward.** Once `insertLiveEventOutboxRow`'s
   transaction holds the advisory lock, it does exactly one thing — insert
   the new row it just created (never a pre-existing, potentially-contended
   row) — and returns. Nothing after the lock acquisition should add more
   locking work, or it extends how long every other writer in the system is
   blocked.

**Global serialization/wait risk:** this design trades write throughput for
ordering correctness. Every outbox insert across every company waits on one
lock, so under high concurrent write volume this is a potential throughput
bottleneck and lock-wait pileup point, not just per-row contention.
`insertLiveEventOutboxRow` measures its own wait
(`lockWaitStartedAt`/`lockWaitMs`) and logs a `logger.warn` only when the wait
meets or exceeds `LOCK_WAIT_WARN_THRESHOLD_MS` (250ms) — deliberately not on
every insert, since at expected volumes the lock is uncontended and
near-instant and per-row logging would be pure noise; a wait past the
threshold is a signal worth an operator's attention.

## Delivery model — two tiers, by design

Plan 005's goal ("a publisher exit cannot silently lose a committed state
transition event") only makes sense for events that represent a durable
state transition. Most existing `publishLiveEvent`/`publishGlobalLiveEvent`
callers (~20+ call sites across `plugins.ts`, `activity-log.ts`,
`external-objects.ts`, `responsible-user-denial-run-outcomes.ts`,
`plugin-host-services.ts`, and most of `heartbeat.ts`) are best-effort
signals, not state itself — and at least one real-Postgres integration test
(`inbox-archive-routes.test.ts`) depends on `subscribeCompanyLiveEvents`
delivering synchronously within the same request, with no fanout consumer
running. Changing that synchronous contract for every caller was out of
scope for "smallest complete."

So delivery is split:

1. **Best-effort tier** (`publishLiveEvent`, `publishGlobalLiveEvent`) —
   unchanged synchronous local `EventEmitter` delivery, exactly as before
   this slice, **plus** a fire-and-forget outbox row write
   (`writeOutboxBestEffort`) once `configureLiveEventOutbox(db, writeEnabled)`
   has run at startup, gated by the write-eligibility rules below. The
   outbox write is not awaited by the caller and is not atomic with any
   state write the caller may have just made.
2. **Transactional tier** (`publishLiveEventTx` + `deliverLiveEventLocally`)
   — the outbox row is written inside the caller's own
   `db.transaction(async (tx) => ...)`, so it commits atomically with the
   state write it accompanies (subject to the same write-eligibility rules).
   `publishLiveEventTx` always returns `{companyId, type, payload}` for the
   caller to hand to `deliverLiveEventLocally` after the transaction
   commits — this happens regardless of whether a durable row was actually
   written, so local delivery is never silently dropped by the allowlist or
   kill switch (see "What gets durably written" below). Currently used by
   exactly two producers: `heartbeat.ts`'s `setRunStatus` and
   `setRunStatusFromLive` — the flagship run-status transition producers,
   matching plan 005's own phased "move heartbeat first" framing.
   Verified end-to-end (not just at the `domain-event-outbox.ts` API level)
   by `heartbeat-runtime-state.test.ts`'s "producer wiring" test, which
   drives a real producer (`heartbeat.cancelRun` → `setRunStatus`) and
   asserts the resulting event actually reaches a
   `subscribeCompanyLiveEvents` listener.

Both tiers write into the same `live_event_outbox` table.

### Event ids — one local counter, not two id spaces

Every event delivered to a local subscriber — whether via the best-effort
tier's synchronous emit, or via the transactional tier's
`deliverLiveEventLocally`, or via a fanout consumer redelivering a peer
replica's row — gets its `event.id` from the single in-memory `nextEventId`
counter (`toLiveEvent()` in `live-events.ts`). The durable outbox row's own
`id` (bigserial) is a separate, internal-only value: it is the fanout
consumer's cursor key and the input to the insert-ordering lock above, but
it is **never** assigned as a client-facing `event.id`. Earlier drafts of
this slice mixed the two — a local subscriber could see one stream where
some events carried the local counter's id and others carried the durable
row's id, which is not a coherent ordering/dedupe contract for a client. Now
there is exactly one id space per stream. Covered by
`live-events.test.ts`'s "share one local id space" test.

One consequence: **there is no durable, client-facing event id to hand back
on reconnect** (see the removed WS replay feature below).

## What gets durably written — allowlist, size cap, redaction, kill switch

Not every event type is safe or appropriate to persist to the database.
`heartbeat.run.log`, `heartbeat.run.progress`, and `heartbeat.run.event` can
carry raw command stdout/stderr and truncated assistant text snippets —
potentially large and potentially sensitive — and are purely
high-frequency UI signal, not state that needs cross-replica durability.
`plugin.ui.updated` is an ephemeral UI hint with no consumer that needs it
durable. So `live-events.ts` enforces, before any outbox write (best-effort
or transactional):

1. **Allowlist** (`OUTBOX_ALLOWED_EVENT_TYPES`) — only these types are ever
   durably written: `heartbeat.run.queued`, `heartbeat.run.status`,
   `agent.status`, `activity.logged`, `external_object.updated`,
   `plugin.worker.crashed`, `plugin.worker.restarted`. Everything else
   (including the four types above) still delivers locally/synchronously as
   before — it just never reaches `live_event_outbox`, so it never fans out
   to peer replicas.
2. **Payload redaction** (`prepareOutboxPayload` → `redactOutboxPayload`) —
   defense-in-depth over the allowlist: a case-insensitive denylist of
   payload keys (`token`, `secret`, `password`, `apikey`, `api_key`,
   `authorization`, `stdout`, `stderr`, `output`, `log`, `snippet`) is
   replaced with `"[redacted]"` before insert, in case an allowlisted event
   type's payload ever picks up one of these fields. The walk is
   **recursive**, not just top-level — `activity.logged`'s `payload.details`
   is an arbitrary, producer-supplied nested object (see `activity-log.ts`'s
   `redactActivityDetails`, a domain-level redaction, not a guarantee a key
   like `token` can never appear a few levels deep in application-shaped
   metadata), so a shallow redaction would miss a sensitive key nested inside
   it. Depth-bounded at `OUTBOX_REDACTION_MAX_DEPTH` (6) so a pathological or
   adversarial payload cannot force unbounded recursion — anything past the
   bound is replaced with a marker string rather than walked further.
3. **Size cap** (`MAX_OUTBOX_PAYLOAD_BYTES = 8192`) — if the redacted
   payload's serialized size exceeds the cap, the payload is replaced with
   `{ truncated: true, originalSizeBytes, ...identityCore }` rather than
   partially truncated (partial truncation of arbitrary JSON risks producing
   malformed or misleading data). `identityCore` (`extractOutboxIdentityCore`,
   keys in `OUTBOX_IDENTITY_CORE_KEYS`: `runId`, `agentId`, `status`,
   `issueId`, `entityId`, `entityType`, `objectId`, `pluginId`) is preserved
   verbatim from the redacted payload so a client that only ever sees the
   truncation marker for an oversized event can still identify and label
   it — e.g. a truncated `heartbeat.run.status` row keeps `runId`/`agentId`/
   `status` even though the rest of the payload is dropped. `issueId` is
   included per explicit review requirement even though no current
   allowlisted payload uses that exact key name, so a future producer that
   does gets this protection for free. The full payload was already
   delivered locally before this cap is applied — only the durable/fanout
   copy is affected.

   **`finalText` duplication:** `heartbeat.run.status`'s `finalText` field
   (see `buildHeartbeatRunStatusLiveEventPayload` in `heartbeat.ts`) is the
   field most likely to push a run-status payload over this cap, and it is
   itself a duplicate of content already durable elsewhere —
   `heartbeat_runs.resultJson` on the run row, and, for issue-linked runs,
   the same text posted as a GitHub issue comment
   (`buildHeartbeatRunIssueComment`). When truncation drops `finalText`, the
   identity core above still survives, and the full text remains available
   from the run row itself.
4. **Kill switch** (`configureLiveEventOutbox(db, writeEnabled)`) — a real,
   process-wide switch on the *write* path, not just consumption. When
   `writeEnabled` is `false`, `isOutboxWriteEligible()` short-circuits to
   `false` for every type, so neither `writeOutboxBestEffort` nor
   `publishLiveEventTx`'s insert ever executes — no row is written, and
   nothing is available for any replica's fanout consumer to pick up. Wired
   from `index.ts` as `configureLiveEventOutbox(db,
   config.liveEventFanoutEnabled)` — reusing the existing
   `PAPERCLIP_LIVE_EVENT_FANOUT_ENABLED` knob as a single end-to-end switch
   for both the write side and the consume/fanout side, rather than adding a
   second flag that could be set inconsistently.

All four points are covered directly by `live-events.test.ts`, against a
real embedded-Postgres database.

## Cross-replica fanout — `createLiveEventFanoutConsumer`

One consumer instance per replica (`server/src/index.ts`, gated by
`PAPERCLIP_LIVE_EVENT_FANOUT_ENABLED`, default on). On `start()`:

- Reads its durable checkpoint (`live_event_fanout_checkpoints`) for its
  `replicaId` (`HOSTNAME`/`POD_NAME`, falling back to a random id — see
  `getLiveEventReplicaId()` in `live-events.ts`).
- If none exists (first boot under this identity), initializes the
  checkpoint at the **current tail** (`getMaxLiveEventOutboxId`), not at 0.
  Bulk replay of the entire outbox table on a fresh boot is explicitly out
  of scope — a client that needs more history than the REST API provides is
  not served by this slice.
- Polls on `PAPERCLIP_LIVE_EVENT_FANOUT_POLL_INTERVAL_MS` (default 1000ms),
  selecting rows `id > cursor` **excluding rows this replica produced
  itself** (`origin_replica_id <> replicaId`) — the producing replica
  already delivered those synchronously at publish time, so re-delivering
  them here would double-fire local subscribers.
- Delivers each row via the `deliver` callback (`deliverLiveEventLocally`,
  which emits on the in-process `EventEmitter` under a *fresh* id from the
  local counter — see "Event ids" above), advancing and persisting the
  checkpoint after each batch.
- **Liveness refresh on every poll, including empty ones.** The checkpoint's
  `updated_at` is upserted after *every* successful poll, not only polls that
  delivered rows — a replica that is alive and polling but has nothing new to
  deliver (an empty poll), or that only ever produces its own rows (already
  excluded by `origin_replica_id <> replicaId` above, so those polls look
  empty too), must not go stale from `deleteStaleFanoutCheckpoints`'s point of
  view. Without this, liveness could only be proven by write activity, and a
  quiet-but-alive replica would eventually become indistinguishable from an
  abandoned one and get garbage collected. The "delivered outbox rows" info
  log is still gated to `rows.length > 0` so this doesn't add per-poll log
  noise.
- **Poison isolation**: a `deliver` callback that throws for one row is
  logged and skipped; the cursor still advances past it, so one bad payload
  cannot wedge fanout for every event after it.
- **Overlap guard**: a `polling` boolean prevents a slow tick's drain loop
  from racing a concurrent timer-triggered tick. This guard lives in the
  interval-driven `pollTick`, not in the exposed `pollUntilDrained()`
  primitive — a test or caller invoking `pollUntilDrained()` directly
  concurrently gets no such protection; only the production `start()` path
  (via `setInterval`) is guarded.

## Removed: WebSocket reconnect replay (`afterEventId`)

An earlier draft of this slice let `live-events-ws.ts`'s upgrade handler
accept an `afterEventId` query param and replay durable outbox rows on
reconnect. This was removed entirely rather than kept, for two reasons:

1. **No caller ever used it.** A grep across the whole frontend/consumer
   surface found zero references to `afterEventId` — it was dead client
   surface from day one of this slice.
2. **It could not have been made correct without either a real client
   contract or a different id model.** The client-facing `event.id` is the
   local in-memory counter (see "Event ids" above), which resets on process
   restart and is not comparable across replicas — there is no stable
   cursor value a client could receive on one connection and legitimately
   hand back on the next to mean "resume after this point." Wiring a
   *usable* replay would have required either exposing the durable row's own
   id to clients (reintroducing the two-id-space problem this slice fixes)
   or designing and shipping a new client-side reconnect protocol, which is
   materially more than "smallest complete" for a slice with no consumer
   asking for it.

If reconnect replay is needed later, it should be designed together with
whichever client will actually consume it, using the durable row id as an
explicit, documented cursor — not reintroduced as a speculative feature.

(The `parseAfterEventId` strict-digits hardening item raised in review is
therefore resolved by removal, not by input hardening: the function no
longer exists. Likewise "upgrade-level replay auth tests" is moot — there is
no replay authorization surface left to test; `live-events-ws.test.ts`'s
existing upgrade-rejection tests are unaffected by the removal.)

## Retention

`runLiveEventOutboxRetentionSweep` deletes outbox rows older than
`PAPERCLIP_LIVE_EVENT_OUTBOX_RETENTION_DAYS` (default 7), in bounded batches
(`PAPERCLIP_LIVE_EVENT_OUTBOX_RETENTION_BATCH_SIZE`, default 500) up to
`PAPERCLIP_LIVE_EVENT_OUTBOX_RETENTION_MAX_BATCHES` batches per sweep
(default 200). The same sweep also deletes stale
`live_event_fanout_checkpoints` rows (`deleteStaleFanoutCheckpoints`, same
cutoff) — a replica identity that falls back to `local-${randomUUID()}`
(no `HOSTNAME`/`POD_NAME` set) creates a new checkpoint row every restart;
without this, those orphaned rows would accumulate forever. Gated by
`PAPERCLIP_LIVE_EVENT_OUTBOX_RETENTION_ENABLED` (default on — opt-out, like
the heartbeat result retention sweeper, because the growth it bounds is
unbounded and rows are ephemeral fanout signal, never a durable audit log).
Boot sweep runs 90s after startup, staggered behind the run-log archiver
(30s) and heartbeat result retention (60s) sweeps so cold-start
detoast-heavy work doesn't collide.

Deletion (not archival) is correct here: nothing durable is meant to survive
outside the row's own fanout window.

## Config knobs — `server/src/config.ts`

| Env var | Default | Meaning |
|---|---|---|
| `PAPERCLIP_LIVE_EVENT_FANOUT_ENABLED` | `true` | Opt-out; disables the fanout consumer for this replica **and** is the write-side kill switch for the outbox (`configureLiveEventOutbox`'s `writeEnabled`) — turning this off stops both new rows being written and existing rows being fanned out. |
| `PAPERCLIP_LIVE_EVENT_FANOUT_POLL_INTERVAL_MS` | `1000` | Poll cadence, clamped ≥100ms. |
| `PAPERCLIP_LIVE_EVENT_FANOUT_BATCH_SIZE` | `200` | Rows per poll iteration, clamped 1–5000. |
| `PAPERCLIP_LIVE_EVENT_OUTBOX_RETENTION_ENABLED` | `true` | Opt-out. |
| `PAPERCLIP_LIVE_EVENT_OUTBOX_RETENTION_DAYS` | `7` | Rows/checkpoints older than this are deleted. |
| `PAPERCLIP_LIVE_EVENT_OUTBOX_RETENTION_INTERVAL_MS` | `3600000` (1h) | Sweep cadence, clamped ≥60s. |
| `PAPERCLIP_LIVE_EVENT_OUTBOX_RETENTION_BATCH_SIZE` | `500` | Rows per delete batch, clamped 1–5000. |
| `PAPERCLIP_LIVE_EVENT_OUTBOX_RETENTION_MAX_BATCHES` | `200` | Max delete batches per sweep (renamed from `..._ITEM_LIMIT`; same semantics — a cap on the number of batches, not on the number of items). |

## Deliberate scope deviation: polling, not `LISTEN`/`NOTIFY`

Plan 005 describes using PostgreSQL `LISTEN`/`NOTIFY` "only to wake polling"
— a latency optimization over plain polling, not a correctness requirement.
`packages/db/src/client.ts` (not in this slice's in-scope file list) only
exposes a Drizzle `Db`, not the underlying `postgres.js` connection `LISTEN`
needs, and safely multiplexing a dedicated raw listen connection (reconnect
handling on disconnect, backpressure) is a materially larger change than
this slice's "smallest complete" scope justifies. This implementation is
pure short-interval polling instead. Correctness (eventual, at-least-once,
checkpointed delivery, and — as of this remediation pass — strict
commit-order-consistent delivery) is unaffected; only wakeup latency is
coarser (bounded by `PAPERCLIP_LIVE_EVENT_FANOUT_POLL_INTERVAL_MS`, default
1s) than a `NOTIFY`-driven design would give. This is a flagged, deliberate
follow-up for a later slice, not a silent gap.

## What is deliberately NOT covered

- **Client-facing reconnect replay.** Removed — see "Removed: WebSocket
  reconnect replay" above. A client needing more history than what it
  already has locally should use the REST API.
- **Bulk/unbounded fanout replay on cold boot.** A fanout consumer's
  first-boot checkpoint starts at the current tail, not 0.
- **Transactional-tier coverage for run-creation events.** Only
  `setRunStatus`/`setRunStatusFromLive` (terminal/lifecycle status
  transitions) use the transactional tier. The six
  `heartbeat.run.queued` publish call sites (run creation/re-queue paths in
  `heartbeat.ts`) remain on the best-effort tier — a dropped queued
  notification is recoverable via the existing list/poll REST APIs, whereas
  a silently-missed terminal status transition is a materially bigger
  correctness gap for anything automating on run completion. This is an
  intentional, bounded exclusion, not an oversight: migrating all six
  call sites to the transactional tier was judged out of scope for
  "smallest complete" given queued-state loss is already
  self-healing via polling.
- **Every other best-effort-tier producer.** All call sites elsewhere in the
  codebase (`plugins.ts`, `activity-log.ts`, `external-objects.ts`,
  `responsible-user-denial-run-outcomes.ts`, `plugin-host-services.ts`, and
  the rest of `heartbeat.ts`) remain on the best-effort tier — see "Delivery
  model" above. Only allowlisted types among them are durably written at
  all (see "What gets durably written" above).
- **Exactly-once delivery.** Explicitly out of scope per the plan's own
  rejected-alternatives table. A client may see a duplicate id (rare, from
  local/fanout overlap) and must dedupe by id.

## Maintenance notes

- New producers that represent a durable, must-not-silently-miss state
  transition should use `publishLiveEventTx`/`deliverLiveEventLocally`
  (transactional tier), following the `setRunStatus`/`setRunStatusFromLive`
  pattern in `heartbeat.ts`. Everything else should stay on
  `publishLiveEvent`/`publishGlobalLiveEvent`.
- Adding a new durable event type requires adding it to
  `OUTBOX_ALLOWED_EVENT_TYPES` in `live-events.ts` — durability is opt-in by
  design, not opt-out, precisely so a future high-frequency or
  sensitive-payload event type does not silently start getting persisted.
- Re-run `server/src/services/domain-event-outbox.test.ts` (two-connection
  embedded-Postgres coverage: insert+peer-read, commit-while-fanout-down,
  cross-replica A-to-B delivery excluding self-origin rows, checkpoint
  restart, held-transaction/insert-ordering regression, duplicate-tick
  overlap guard, poison isolation, retention boundary, stale-checkpoint
  cleanup, forced-failure rollback atomicity in both directions —
  outbox-insert-failure-rolls-back-caller's-state-write and
  state-write-failure-after-outbox-insert-rolls-back-that-row-too — and
  checkpoint liveness on an empty poll surviving stale-GC) and
  `server/src/services/live-events.test.ts` (allowlist, payload
  cap/truncation, identity-core preservation through truncation, recursive
  bounded redaction against a production-shaped nested `activity.logged`
  payload, redaction depth bound, kill switch, unified event-id space) after
  any change to the outbox schema, fanout consumer, retention sweep, or
  write-eligibility rules. `server/src/__tests__/heartbeat-runtime-state.test.ts`'s
  "producer wiring" test now configures a real outbox
  (`configureLiveEventOutbox(db, true)`) and asserts the durable row directly,
  not just local delivery.
- `server/src/__tests__/inbox-archive-routes.test.ts` is the canary for the
  best-effort tier's backward-compatibility contract (synchronous same-
  request delivery with no fanout consumer running) — if this ever needs to
  change, that test's expectations need to change first, deliberately.
- `server/src/__tests__/heartbeat-runtime-state.test.ts`'s "producer wiring"
  test is the canary for the transactional tier actually being reachable
  from a real producer, not just from direct calls into
  `domain-event-outbox.ts`.
