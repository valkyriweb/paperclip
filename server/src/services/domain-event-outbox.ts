import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { liveEventFanoutCheckpoints, liveEventOutbox } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Durable event outbox + cross-replica fanout (active-active plan 005).
 *
 * See `doc/operations/live-event-replay.md` for the operator-facing design
 * summary and `live-events.ts` for how producers reach this module.
 *
 * Scope note: the plan's "Use notification only to wake polling" step
 * describes a `LISTEN`/`NOTIFY` wakeup as a latency optimization over plain
 * polling. `packages/db/src/client.ts` (not in this slice's in-scope path
 * list) only exposes a Drizzle `Db`, not the underlying `postgres.js`
 * connection `LISTEN` needs, and safely multiplexing a dedicated raw
 * connection (reconnect handling, backpressure) is a meaningfully larger
 * change than this slice's "smallest complete" scope. This implementation is
 * pure short-interval polling instead — correctness (eventual, at-least-once,
 * checkpointed delivery) is unaffected; only wakeup latency is coarser than a
 * `NOTIFY`-driven design would give. Flagged as a deferred follow-up, not a
 * silent gap.
 */

/** Accepts either a plain `Db` or a transaction handle from `db.transaction(async (tx) => ...)`. */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface LiveEventOutboxRow {
  id: number;
  companyId: string;
  type: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  originReplicaId: string;
  createdAt: Date;
}

/**
 * Advisory-lock key (see `hashtext(<string>)` convention in
 * `routes/cases.ts`) serializing every `live_event_outbox` insert.
 *
 * Why this is required, not just belt-and-braces: under MVCC, `nextval()`
 * allocation order and commit order are independent — a transaction that
 * allocates a lower id can still commit *after* a concurrent transaction that
 * allocated a higher id (e.g. it's slower, or held open by the caller). The
 * fanout poller reads `WHERE id > cursor ORDER BY id` and advances its
 * checkpoint to the highest id it has seen; if a higher id becomes visible
 * before a lower one commits, the poller advances past it, and once the
 * lower id finally commits it can never be selected again (`id > checkpoint`
 * permanently excludes it) — a silent, permanent skip.
 *
 * `pg_advisory_xact_lock` is transaction-scoped (auto-released at
 * commit/rollback, no manual unlock needed) and acquired here as the very
 * first statement of the transaction that also performs the insert, before
 * that transaction's `nextval()` draw. Any other transaction trying to
 * insert blocks until this one commits or rolls back, which forces
 * `nextval()` allocation order to equal commit order for this table: by the
 * time a transaction is allowed to allocate id N, every transaction that
 * will ever allocate an id < N has already committed. That makes the
 * poller's naive `checkpoint = max(id seen)` correct by construction — see
 * `domain-event-outbox.test.ts`'s "held-transaction regression" test and
 * `doc/operations/live-event-replay.md`.
 *
 * LOCK ORDERING INVARIANT — outbox lock last, no row locks after it:
 * because this is a single *global* key (not per-company, not per-row),
 * every concurrent outbox writer across the whole process — regardless of
 * company — serializes on it. Two consequences callers must respect:
 *
 * 1. **Acquire it last.** `publishLiveEventTx`'s callers (e.g. `heartbeat.ts`'s
 *    `setRunStatus`/`setRunStatusFromLive`) must take their own row locks
 *    (e.g. `UPDATE heartbeat_runs ... WHERE id = ...`) BEFORE calling
 *    `publishLiveEventTx`, never after. If a caller instead acquired the
 *    global advisory lock first and only then went on to lock rows, every
 *    other outbox writer in the whole system would queue up behind it for
 *    the duration of that row work too — turning a narrow, row-scoped wait
 *    into a global one, and, if any concurrent transaction locks the same
 *    rows in the opposite order (advisory lock inside a transaction that
 *    also holds row locks another transaction wants first), a deadlock.
 * 2. **Take no further row locks afterward.** Once this function's own
 *    transaction/savepoint holds the advisory lock, it does exactly one
 *    thing — the `INSERT` below, which only ever locks the brand-new row it
 *    just created (never a pre-existing, potentially-contended row) — and
 *    then returns. Adding any other locking work after the advisory lock is
 *    acquired, inside this function or a caller's enclosing transaction,
 *    would extend how long every other writer in the system is blocked.
 *
 * Global serialization/wait risk: this design trades write throughput for
 * ordering correctness. Every outbox insert across every company waits on
 * one lock, so under high concurrent write volume this can become a
 * throughput bottleneck / lock-wait pileup, not just a per-row contention
 * point. See the wait-duration logging below for how that's surfaced.
 */
export const LIVE_EVENT_OUTBOX_INSERT_LOCK_KEY = "paperclip:live_event_outbox_append";

/** Lock-wait duration (ms) above which `insertLiveEventOutboxRow` logs a warning. Deliberately not logged on every insert — at expected volumes this lock is uncontended and near-instant, so per-row logging would be pure noise; only a wait long enough to suggest real contention is worth an operator's attention. */
const LOCK_WAIT_WARN_THRESHOLD_MS = 250;

/**
 * Insert one outbox row, serialized against every other outbox insert (see
 * `LIVE_EVENT_OUTBOX_INSERT_LOCK_KEY`, including its lock-ordering
 * invariant). Pass a transaction handle (`tx`) here to commit the row
 * atomically with a state write in the same transaction — see
 * `publishLiveEventTx` in `live-events.ts` and its heartbeat run-status
 * callers for the pattern this slice migrates first. Callers using `tx` must
 * have already taken any row locks of their own before calling this — see
 * the lock-ordering invariant above.
 *
 * Always opens its own transaction (a real one via `db.transaction()` when
 * given a plain `Db`, or a `SAVEPOINT` when already inside a transaction —
 * see `PostgresJsTransaction.transaction()`). A savepoint does not narrow
 * the advisory lock's scope: `pg_advisory_xact_lock` is tied to the
 * top-level transaction, so when called from within `publishLiveEventTx`'s
 * caller-owned transaction the lock is still held for that transaction's
 * full duration, exactly as required.
 */
export async function insertLiveEventOutboxRow(
  dbOrTx: DbOrTx,
  input: {
    companyId: string;
    type: string;
    payload: Record<string, unknown>;
    originReplicaId: string;
    schemaVersion?: number;
  },
): Promise<LiveEventOutboxRow> {
  return dbOrTx.transaction(async (tx) => {
    const lockWaitStartedAt = Date.now();
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LIVE_EVENT_OUTBOX_INSERT_LOCK_KEY}))`);
    const lockWaitMs = Date.now() - lockWaitStartedAt;
    if (lockWaitMs >= LOCK_WAIT_WARN_THRESHOLD_MS) {
      logger.warn(
        { lockWaitMs },
        "live event outbox: insert lock wait exceeded threshold — possible global write contention",
      );
    }
    const [row] = await tx
      .insert(liveEventOutbox)
      .values({
        companyId: input.companyId,
        type: input.type,
        schemaVersion: input.schemaVersion ?? 1,
        payload: input.payload,
        originReplicaId: input.originReplicaId,
      })
      .returning();
    if (!row) throw new Error("live_event_outbox insert returned no row");
    return row;
  });
}

/**
 * Rows for ANY company after `afterId`, excluding rows this replica produced
 * itself (already delivered synchronously at publish time — see
 * `live-events.ts`). This is the query the fanout consumer polls.
 */
export async function selectLiveEventOutboxRowsForFanout(
  db: Db,
  input: { afterId: number; limit: number; excludeOriginReplicaId: string },
): Promise<LiveEventOutboxRow[]> {
  return db
    .select()
    .from(liveEventOutbox)
    .where(
      and(
        gt(liveEventOutbox.id, input.afterId),
        sql`${liveEventOutbox.originReplicaId} <> ${input.excludeOriginReplicaId}`,
      ),
    )
    .orderBy(asc(liveEventOutbox.id))
    .limit(input.limit);
}

export async function getMaxLiveEventOutboxId(db: Db): Promise<number> {
  const [row] = await db
    .select({ id: liveEventOutbox.id })
    .from(liveEventOutbox)
    .orderBy(desc(liveEventOutbox.id))
    .limit(1);
  return row?.id ?? 0;
}

export async function getFanoutCheckpoint(db: Db, replicaId: string): Promise<number | null> {
  const [row] = await db
    .select()
    .from(liveEventFanoutCheckpoints)
    .where(eq(liveEventFanoutCheckpoints.replicaId, replicaId));
  return row?.lastDeliveredId ?? null;
}

export async function upsertFanoutCheckpoint(
  db: DbOrTx,
  input: { replicaId: string; lastDeliveredId: number },
): Promise<void> {
  await db
    .insert(liveEventFanoutCheckpoints)
    .values({ replicaId: input.replicaId, lastDeliveredId: input.lastDeliveredId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: liveEventFanoutCheckpoints.replicaId,
      set: { lastDeliveredId: input.lastDeliveredId, updatedAt: new Date() },
    });
}

/**
 * Retention delete, oldest-first, bounded to `batchSize` rows per call so a
 * large backlog cannot hold a single multi-minute transaction. Callers loop
 * until `deleted < batchSize` (see `runLiveEventOutboxRetentionSweep`).
 *
 * Postgres has no `DELETE ... LIMIT`; the `id IN (SELECT ...)` subquery is
 * the standard bounded-delete idiom.
 */
export async function deleteExpiredLiveEventOutboxRows(
  db: Db,
  input: { cutoff: Date; batchSize: number },
): Promise<number> {
  const raw = await db.execute(sql`
    delete from ${liveEventOutbox}
    where id in (
      select id from ${liveEventOutbox}
      where created_at < ${input.cutoff.toISOString()}::timestamptz
      order by id
      limit ${input.batchSize}
    )
    returning id
  `);
  const rows = Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? []);
  return rows.length;
}

export interface LiveEventOutboxRetentionConfig {
  retentionDays: number;
  batchSize: number;
  /**
   * Ceiling on how many `batchSize`-sized delete batches one sweep call will
   * run. Named for what it bounds (delete batches per sweep invocation), not
   * "items" — a sweep can delete at most `maxBatches * batchSize` rows before
   * yielding back to the caller, regardless of how large the backlog is.
   */
  maxBatches: number;
}

export interface LiveEventOutboxRetentionResult {
  deleted: number;
  batches: number;
}

/**
 * Deletes outbox rows older than `retentionDays`. Bounds unbounded growth —
 * see plan 005's STOP condition ("no owner bounds storage"). Rows are
 * ephemeral fanout/replay signal, never a durable audit log, so deletion
 * (not archival) is correct here.
 */
export async function runLiveEventOutboxRetentionSweep(
  db: Db,
  config: LiveEventOutboxRetentionConfig,
  now: () => Date = () => new Date(),
): Promise<LiveEventOutboxRetentionResult> {
  const cutoff = new Date(now().getTime() - config.retentionDays * 24 * 60 * 60 * 1000);
  let deleted = 0;
  let batches = 0;
  while (batches < config.maxBatches) {
    const removed = await deleteExpiredLiveEventOutboxRows(db, { cutoff, batchSize: config.batchSize });
    deleted += removed;
    batches += 1;
    if (removed < config.batchSize) break;
  }
  const staleCheckpoints = await deleteStaleFanoutCheckpoints(db, { cutoff });
  if (deleted > 0 || staleCheckpoints > 0) {
    logger.info(
      { deleted, batches, staleCheckpoints, retentionDays: config.retentionDays, cutoff: cutoff.toISOString() },
      "live event outbox retention: sweep complete",
    );
  }
  return { deleted, batches };
}

/**
 * Deletes fanout-checkpoint rows that haven't been touched since `cutoff`.
 * `getLiveEventReplicaId()` falls back to a random per-process id when
 * neither `HOSTNAME` nor `POD_NAME` is set (local dev, some test/CI
 * contexts), so replica churn under that fallback would otherwise leave an
 * unbounded number of orphaned checkpoint rows — one per process start,
 * never revisited. A checkpoint only stays fresh while its replica is alive
 * and polling (every successful poll upserts it — see
 * `createLiveEventFanoutConsumer`'s `pollOnce`), so "untouched since cutoff"
 * is a safe proxy for "abandoned". Reuses the same retention cutoff as the
 * outbox rows themselves rather than a separate knob — both bound the same
 * kind of ephemeral fanout state.
 */
export async function deleteStaleFanoutCheckpoints(db: Db, input: { cutoff: Date }): Promise<number> {
  const raw = await db.execute(sql`
    delete from ${liveEventFanoutCheckpoints}
    where updated_at < ${input.cutoff.toISOString()}::timestamptz
    returning replica_id
  `);
  const rows = Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? []);
  return rows.length;
}

export interface LiveEventFanoutConsumerOptions {
  db: Db;
  replicaId: string;
  pollIntervalMs: number;
  batchSize: number;
  deliver: (row: LiveEventOutboxRow) => void;
  log?: Pick<typeof logger, "info" | "warn" | "error">;
}

export interface LiveEventFanoutConsumer {
  /** Initializes the checkpoint (if needed) and starts the poll interval. */
  start(): Promise<void>;
  stop(): void;
  /** Runs poll iterations until the backlog is drained. Exposed for tests; `start()` schedules this on an interval in production. */
  pollUntilDrained(): Promise<{ delivered: number }>;
}

/**
 * One consumer instance per replica. Delivers outbox rows produced by OTHER
 * replicas to this replica's local subscribers (`deliver`, wired to
 * `live-events.ts`'s in-process `EventEmitter` — see `configureLiveEventOutbox`).
 */
export function createLiveEventFanoutConsumer(opts: LiveEventFanoutConsumerOptions): LiveEventFanoutConsumer {
  const log = opts.log ?? logger;
  let cursor = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let polling = false;

  async function initializeCursor(): Promise<void> {
    const existing = await getFanoutCheckpoint(opts.db, opts.replicaId);
    if (existing !== null) {
      cursor = existing;
      return;
    }
    // First boot under this replica identity: start from the current tail
    // rather than replaying the whole table to freshly (re)connected sockets
    // (bulk replay is explicitly out of scope for this slice).
    cursor = await getMaxLiveEventOutboxId(opts.db);
    await upsertFanoutCheckpoint(opts.db, { replicaId: opts.replicaId, lastDeliveredId: cursor });
    log.info({ replicaId: opts.replicaId, cursor }, "live event fanout: initialized checkpoint at current tail");
  }

  async function pollOnce(): Promise<{ delivered: number; drained: boolean }> {
    const rows = await selectLiveEventOutboxRowsForFanout(opts.db, {
      afterId: cursor,
      limit: opts.batchSize,
      excludeOriginReplicaId: opts.replicaId,
    });
    let delivered = 0;
    for (const row of rows) {
      try {
        opts.deliver(row);
        delivered += 1;
      } catch (err) {
        // Poison isolation: a bad row must not block delivery of the rows
        // after it, and the cursor still advances past it below — a
        // permanently-throwing deliver callback drops that one event from
        // fanout rather than wedging the whole consumer on it forever.
        log.error(
          { err, eventId: row.id, companyId: row.companyId, type: row.type },
          "live event fanout: delivery failed for outbox row; skipping and advancing past it",
        );
      }
      cursor = row.id;
    }
    // Refresh the checkpoint's `updated_at` on EVERY successful poll, even
    // one that delivered nothing — a replica that is alive and polling but
    // has no cross-replica rows to deliver (an empty poll) or only ever
    // produces its own rows (already filtered out by the query above, so
    // those polls look empty too) must not go stale from
    // `deleteStaleFanoutCheckpoints`'s point of view. Without this, liveness
    // could only ever be proven by write activity, and a quiet-but-alive
    // replica would eventually become indistinguishable from an abandoned
    // one and get garbage collected. `cursor` is unchanged from its prior
    // value when `rows` is empty, so this is a liveness touch, not a cursor
    // advance.
    await upsertFanoutCheckpoint(opts.db, { replicaId: opts.replicaId, lastDeliveredId: cursor });
    if (rows.length > 0) {
      const lastRow = rows[rows.length - 1]!;
      const lagMs = Date.now() - lastRow.createdAt.getTime();
      log.info(
        { replicaId: opts.replicaId, delivered, cursor, lagMs },
        "live event fanout: delivered outbox rows",
      );
    }
    return { delivered, drained: rows.length < opts.batchSize };
  }

  async function pollUntilDrained(): Promise<{ delivered: number }> {
    let totalDelivered = 0;
    let drained = false;
    while (!drained && !stopped) {
      const result = await pollOnce();
      totalDelivered += result.delivered;
      drained = result.drained;
    }
    return { delivered: totalDelivered };
  }

  async function pollTick(): Promise<void> {
    // Overlap guard: if a previous tick's drain loop is still running (e.g. a
    // slow query), a second concurrent tick would race the same cursor. Not
    // an error — it just means the next tick's work happens on the tick
    // after this one finishes; no events are skipped either way, since the
    // query is always `id > cursor`.
    if (polling || stopped) return;
    polling = true;
    try {
      await pollUntilDrained();
    } catch (err) {
      log.error({ err, replicaId: opts.replicaId }, "live event fanout: poll tick failed");
    } finally {
      polling = false;
    }
  }

  return {
    async start() {
      await initializeCursor();
      timer = setInterval(() => {
        void pollTick();
      }, opts.pollIntervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    pollUntilDrained,
  };
}
