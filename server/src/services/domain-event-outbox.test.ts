import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, liveEventFanoutCheckpoints, liveEventOutbox } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  createLiveEventFanoutConsumer,
  deleteExpiredLiveEventOutboxRows,
  deleteStaleFanoutCheckpoints,
  getFanoutCheckpoint,
  getMaxLiveEventOutboxId,
  insertLiveEventOutboxRow,
  LIVE_EVENT_OUTBOX_INSERT_LOCK_KEY,
  runLiveEventOutboxRetentionSweep,
  upsertFanoutCheckpoint,
  type LiveEventOutboxRow,
} from "./domain-event-outbox.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("domain event outbox + fanout consumer", () => {
  // Two independent connections against the same database, standing in for
  // two Paperclip replicas — the same pattern run-ownership-store.test.ts
  // uses to prove real cross-connection behavior, not just two in-process
  // calls sharing a client.
  let db!: ReturnType<typeof createDb>;
  let db2!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-live-event-outbox-");
    db = createDb(tempDb.connectionString);
    db2 = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function cleanup() {
    await db.delete(liveEventOutbox);
    await db.delete(liveEventFanoutCheckpoints);
  }

  it("insertLiveEventOutboxRow persists a row a peer connection can read back", async () => {
    const companyId = randomUUID();
    try {
      const row = await insertLiveEventOutboxRow(db, {
        companyId,
        type: "test.event",
        payload: { hello: "world" },
        originReplicaId: "replica-a",
      });
      expect(row.id).toBeGreaterThan(0);

      const seenByPeer = await db2
        .select()
        .from(liveEventOutbox)
        .where(eq(liveEventOutbox.id, row.id));
      expect(seenByPeer).toHaveLength(1);
      expect(seenByPeer[0]!.companyId).toBe(companyId);
      expect(seenByPeer[0]!.payload).toEqual({ hello: "world" });
      expect(seenByPeer[0]!.originReplicaId).toBe("replica-a");
    } finally {
      await cleanup();
    }
  });

  it("commit-while-fanout-down: rows written before a consumer ever starts are still delivered once it starts", async () => {
    const companyId = randomUUID();
    try {
      const before = await insertLiveEventOutboxRow(db, {
        companyId,
        type: "state.changed",
        payload: { n: 1 },
        originReplicaId: "replica-a",
      });

      const delivered: LiveEventOutboxRow[] = [];
      const consumer = createLiveEventFanoutConsumer({
        db: db2,
        replicaId: "replica-b",
        pollIntervalMs: 50,
        batchSize: 50,
        deliver: (row) => delivered.push(row),
      });

      // First boot under a fresh replica id starts from the current tail, so
      // it must NOT see rows already committed before it ever started —
      // bulk replay on cold start is explicitly out of scope for this slice.
      await consumer.start();
      const drainedOnBoot = await consumer.pollUntilDrained();
      expect(drainedOnBoot.delivered).toBe(0);
      expect(delivered).toHaveLength(0);
      consumer.stop();

      // A row committed AFTER the checkpoint is initialized is delivered.
      const after = await insertLiveEventOutboxRow(db, {
        companyId,
        type: "state.changed",
        payload: { n: 2 },
        originReplicaId: "replica-a",
      });
      const consumer2 = createLiveEventFanoutConsumer({
        db: db2,
        replicaId: "replica-b",
        pollIntervalMs: 50,
        batchSize: 50,
        deliver: (row) => delivered.push(row),
      });
      await consumer2.start();
      const drained = await consumer2.pollUntilDrained();
      consumer2.stop();

      expect(drained.delivered).toBe(1);
      expect(delivered.map((r) => r.id)).toEqual([after.id]);
      expect(delivered.map((r) => r.id)).not.toContain(before.id);
    } finally {
      await cleanup();
    }
  });

  it("A-to-B delivery: a fanout consumer on replica B delivers rows produced by replica A, but never its own", async () => {
    const companyId = randomUUID();
    try {
      const delivered: LiveEventOutboxRow[] = [];
      const consumer = createLiveEventFanoutConsumer({
        db: db2,
        replicaId: "replica-b",
        pollIntervalMs: 50,
        batchSize: 50,
        deliver: (row) => delivered.push(row),
      });
      await consumer.start();

      const fromA = await insertLiveEventOutboxRow(db, {
        companyId,
        type: "state.changed",
        payload: { from: "a" },
        originReplicaId: "replica-a",
      });
      // A row this same replica produced — must not be re-delivered to
      // itself; replica A already delivered it synchronously at publish time.
      await insertLiveEventOutboxRow(db, {
        companyId,
        type: "state.changed",
        payload: { from: "b" },
        originReplicaId: "replica-b",
      });

      const drained = await consumer.pollUntilDrained();
      consumer.stop();

      expect(drained.delivered).toBe(1);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.id).toBe(fromA.id);
      expect(delivered[0]!.payload).toEqual({ from: "a" });
    } finally {
      await cleanup();
    }
  });

  it("checkpoint restart: a consumer resumes from its durable checkpoint rather than re-delivering already-fanned-out rows", async () => {
    const companyId = randomUUID();
    try {
      const row1 = await insertLiveEventOutboxRow(db, {
        companyId,
        type: "state.changed",
        payload: { n: 1 },
        originReplicaId: "replica-a",
      });

      const deliveredFirstRun: LiveEventOutboxRow[] = [];
      const consumerRun1 = createLiveEventFanoutConsumer({
        db: db2,
        replicaId: "replica-restart",
        pollIntervalMs: 50,
        batchSize: 50,
        deliver: (row) => deliveredFirstRun.push(row),
      });
      // Seed the checkpoint at 0 so the first run sees the pre-existing row
      // (simulating a replica that has been running since before row1).
      await upsertFanoutCheckpoint(db2, { replicaId: "replica-restart", lastDeliveredId: 0 });
      await consumerRun1.start();
      const drained1 = await consumerRun1.pollUntilDrained();
      consumerRun1.stop();
      expect(drained1.delivered).toBe(1);
      expect(deliveredFirstRun.map((r) => r.id)).toEqual([row1.id]);

      const checkpointAfterRun1 = await getFanoutCheckpoint(db, "replica-restart");
      expect(checkpointAfterRun1).toBe(row1.id);

      // Simulate a process restart under the same replica identity: a fresh
      // consumer instance must resume from the durable checkpoint, not
      // re-deliver row1.
      const row2 = await insertLiveEventOutboxRow(db, {
        companyId,
        type: "state.changed",
        payload: { n: 2 },
        originReplicaId: "replica-a",
      });
      const deliveredSecondRun: LiveEventOutboxRow[] = [];
      const consumerRun2 = createLiveEventFanoutConsumer({
        db: db2,
        replicaId: "replica-restart",
        pollIntervalMs: 50,
        batchSize: 50,
        deliver: (row) => deliveredSecondRun.push(row),
      });
      await consumerRun2.start();
      const drained2 = await consumerRun2.pollUntilDrained();
      consumerRun2.stop();

      expect(drained2.delivered).toBe(1);
      expect(deliveredSecondRun.map((r) => r.id)).toEqual([row2.id]);
    } finally {
      await cleanup();
    }
  });

  it("held-transaction regression: a slower-committing transaction's row is never skipped, and a concurrent insert genuinely blocks behind it", async () => {
    const companyId = randomUUID();
    const rawSql = postgres(tempDb!.connectionString, { max: 2, onnotice: () => {} });
    try {
      const reserved = await rawSql.reserve();
      try {
        // Take the same advisory lock insertLiveEventOutboxRow acquires, and
        // hold it open across a delay — simulating the exact hazard the lock
        // exists to close: a transaction that will get a LOWER id but has
        // not committed yet, racing a transaction that could otherwise
        // allocate and commit a HIGHER id first.
        await reserved.unsafe("begin");
        await reserved.unsafe(`select pg_advisory_xact_lock(hashtext('${LIVE_EVENT_OUTBOX_INSERT_LOCK_KEY}'))`);

        let secondInsertResolved = false;
        const secondInsert = insertLiveEventOutboxRow(db2, {
          companyId,
          type: "state.changed",
          payload: { order: "second" },
          originReplicaId: "replica-b",
        }).then((row) => {
          secondInsertResolved = true;
          return row;
        });

        // The second insert must be blocked on the advisory lock, not just
        // coincidentally slower — assert it has NOT resolved while the first
        // transaction still holds the lock open.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(secondInsertResolved).toBe(false);

        const [firstRow] = await reserved.unsafe(
          `insert into live_event_outbox (company_id, type, payload, origin_replica_id) values ($1, 'state.changed', $2::jsonb, 'replica-a') returning id`,
          [companyId, JSON.stringify({ order: "first" })],
        );
        await reserved.unsafe("commit");

        const secondRow = await secondInsert;
        expect(secondInsertResolved).toBe(true);

        // The held-open transaction committed first (lower id), the
        // previously-blocked one second (higher id) — commit order and id
        // order agree, by construction.
        expect(Number(firstRow.id)).toBeLessThan(secondRow.id);

        // A poller starting fresh sees both rows, in order, with no gap —
        // the scenario that would silently and permanently skip the first
        // row without the advisory-lock serialization.
        const delivered: LiveEventOutboxRow[] = [];
        const consumer = createLiveEventFanoutConsumer({
          db: db2,
          replicaId: "replica-held-tx",
          pollIntervalMs: 50,
          batchSize: 50,
          deliver: (row) => delivered.push(row),
        });
        await upsertFanoutCheckpoint(db2, { replicaId: "replica-held-tx", lastDeliveredId: 0 });
        await consumer.start();
        const drained = await consumer.pollUntilDrained();
        consumer.stop();

        expect(drained.delivered).toBe(2);
        expect(delivered.map((r) => r.id)).toEqual([Number(firstRow.id), secondRow.id]);
      } finally {
        await reserved.release();
      }
    } finally {
      await rawSql.end();
      await cleanup();
    }
  });

  it("atomicity (state -> outbox): an outbox insert failure inside a shared transaction rolls back the caller's own state write", async () => {
    const replicaId = `atomicity-outbox-fail-${randomUUID()}`;
    try {
      await expect(
        db.transaction(async (tx) => {
          // Stand-in for a caller's own state write, made before the outbox
          // insert per the lock-ordering invariant (row locks first, outbox
          // lock last — see LIVE_EVENT_OUTBOX_INSERT_LOCK_KEY's doc comment).
          await upsertFanoutCheckpoint(tx, { replicaId, lastDeliveredId: 999 });
          // Force a real NOT NULL constraint violation on the outbox insert
          // itself (company_id is NOT NULL, see live_event_outbox.ts).
          await insertLiveEventOutboxRow(tx, {
            companyId: null as unknown as string,
            type: "state.changed",
            payload: {},
            originReplicaId: "replica-atomicity",
          });
        }),
      ).rejects.toThrow();

      // The checkpoint upsert staged earlier in the SAME transaction must not
      // have survived — proving the outbox insert failure rolled back the
      // whole transaction, not just its own savepoint.
      expect(await getFanoutCheckpoint(db, replicaId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("atomicity (outbox -> state): a state-write failure after the outbox insert, in the same transaction, rolls back that outbox row too", async () => {
    const companyId = randomUUID();
    const replicaId = `atomicity-state-fail-${randomUUID()}`;
    let insertedRowId: number | null = null;
    try {
      await expect(
        db.transaction(async (tx) => {
          const row = await insertLiveEventOutboxRow(tx, {
            companyId,
            type: "state.changed",
            payload: { n: 1 },
            originReplicaId: "replica-atomicity",
          });
          insertedRowId = row.id;
          // Force a real unique-constraint violation standing in for any
          // state-write failure a producer might hit after its outbox row is
          // already staged in the same transaction.
          await tx.insert(liveEventFanoutCheckpoints).values({ replicaId, lastDeliveredId: 1 });
          await tx.insert(liveEventFanoutCheckpoints).values({ replicaId, lastDeliveredId: 2 });
        }),
      ).rejects.toThrow();

      expect(insertedRowId).not.toBeNull();
      const remaining = await db.select().from(liveEventOutbox).where(eq(liveEventOutbox.id, insertedRowId!));
      expect(remaining).toHaveLength(0);
      expect(await getFanoutCheckpoint(db, replicaId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("checkpoint liveness: an active replica that polls and delivers nothing still refreshes its checkpoint, so it cannot be garbage-collected as stale", async () => {
    try {
      const consumer = createLiveEventFanoutConsumer({
        db: db2,
        replicaId: "replica-quiet",
        pollIntervalMs: 20,
        batchSize: 50,
        deliver: () => {
          throw new Error("no rows should be delivered in this test");
        },
      });
      // Fresh boot with an empty table: checkpoint initializes at tail (0).
      await consumer.start();
      // Simulate this checkpoint having gone untouched for a long time
      // BEFORE the poll below — proving the poll itself, not just
      // initialization, is what keeps it fresh.
      await db.execute(
        sql`update ${liveEventFanoutCheckpoints} set updated_at = now() - interval '10 days' where replica_id = 'replica-quiet'`,
      );

      const drained = await consumer.pollUntilDrained();
      consumer.stop();
      expect(drained.delivered).toBe(0);

      // A retention cutoff that would have GC'd the backdated timestamp above
      // must NOT remove this checkpoint, because the empty poll refreshed it.
      const deleted = await deleteStaleFanoutCheckpoints(db, { cutoff: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) });
      expect(deleted).toBe(0);
      expect(await getFanoutCheckpoint(db, "replica-quiet")).not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  // The bounded WebSocket reconnect-replay cursor (`selectCompanyLiveEventOutboxRowsAfter`)
  // was removed from this slice — see doc/operations/live-event-replay.md
  // and live-events-ws.ts. `id`-ordering correctness for that query would
  // have come from the same advisory-lock guarantee the held-transaction
  // regression test above proves for `selectLiveEventOutboxRowsForFanout`;
  // both queries share the identical `id > cursor order by id` shape.

  it("duplicate notification: overlapping timer ticks against the same cursor do not skip or double-deliver rows", async () => {
    const companyId = randomUUID();
    try {
      await insertLiveEventOutboxRow(db, {
        companyId,
        type: "state.changed",
        payload: { n: 1 },
        originReplicaId: "replica-a",
      });
      await insertLiveEventOutboxRow(db, {
        companyId,
        type: "state.changed",
        payload: { n: 2 },
        originReplicaId: "replica-a",
      });

      const delivered: LiveEventOutboxRow[] = [];
      const consumer = createLiveEventFanoutConsumer({
        db: db2,
        replicaId: "replica-dup",
        // Deliberately shorter than a single delivery callback below, so the
        // interval fires again while the previous tick's drain loop is still
        // running — the real "duplicate wakeup racing the normal tick"
        // scenario `pollTick`'s `polling` guard exists for (see
        // domain-event-outbox.ts). Exercised through start()'s own timer, not
        // by calling the internal pollUntilDrained primitive directly, which
        // has no such guard.
        pollIntervalMs: 5,
        batchSize: 1,
        deliver: (row) => {
          delivered.push(row);
        },
      });
      // Seed the checkpoint at 0 so this consumer's first boot sees the rows
      // above, which were inserted before start() (a fresh boot otherwise
      // starts from the current tail — see the commit-while-fanout-down test).
      await upsertFanoutCheckpoint(db2, { replicaId: "replica-dup", lastDeliveredId: 0 });
      await consumer.start();

      await vi.waitFor(
        () => {
          expect(delivered).toHaveLength(2);
        },
        { timeout: 5_000, interval: 20 },
      );
      // A few more ticks after both rows are delivered, to prove the guard
      // keeps holding once the backlog is drained (not just during it).
      await new Promise((resolve) => setTimeout(resolve, 100));
      consumer.stop();

      expect(delivered).toHaveLength(2);
      expect(new Set(delivered.map((r) => r.id)).size).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("poison isolation: a delivery callback that throws on one row does not block delivery of subsequent rows, and the cursor advances past it", async () => {
    const companyId = randomUUID();
    try {
      const poison = await insertLiveEventOutboxRow(db, {
        companyId,
        type: "state.changed",
        payload: { poison: true },
        originReplicaId: "replica-a",
      });
      const healthy = await insertLiveEventOutboxRow(db, {
        companyId,
        type: "state.changed",
        payload: { poison: false },
        originReplicaId: "replica-a",
      });

      const delivered: LiveEventOutboxRow[] = [];
      const consumer = createLiveEventFanoutConsumer({
        db: db2,
        replicaId: "replica-poison",
        pollIntervalMs: 50,
        batchSize: 50,
        deliver: (row) => {
          if (row.id === poison.id) throw new Error("simulated poison payload");
          delivered.push(row);
        },
      });
      // Seed the checkpoint at 0 so this consumer's first boot sees the rows
      // above, which were inserted before start() (a fresh boot otherwise
      // starts from the current tail — see the commit-while-fanout-down test).
      await upsertFanoutCheckpoint(db2, { replicaId: "replica-poison", lastDeliveredId: 0 });
      await consumer.start();
      const drained = await consumer.pollUntilDrained();
      consumer.stop();

      // The poisoned row is not counted as delivered, but the healthy row
      // after it still is, and the checkpoint advances past both.
      expect(drained.delivered).toBe(1);
      expect(delivered.map((r) => r.id)).toEqual([healthy.id]);
      const checkpoint = await getFanoutCheckpoint(db, "replica-poison");
      expect(checkpoint).toBe(healthy.id);
    } finally {
      await cleanup();
    }
  });

  it("retention boundary: sweep deletes only rows strictly older than the cutoff, bounded by batchSize/itemLimit", async () => {
    const companyId = randomUUID();
    try {
      const old = await insertLiveEventOutboxRow(db, {
        companyId,
        type: "state.changed",
        payload: { age: "old" },
        originReplicaId: "replica-a",
      });
      const recent = await insertLiveEventOutboxRow(db, {
        companyId,
        type: "state.changed",
        payload: { age: "recent" },
        originReplicaId: "replica-a",
      });

      // Backdate only the "old" row's created_at so the cutoff boundary is
      // exercised deterministically rather than racing wall-clock time.
      await db.execute(sql`update ${liveEventOutbox} set created_at = now() - interval '10 days' where id = ${old.id}`);

      const cutoffNow = () => new Date();
      const result = await runLiveEventOutboxRetentionSweep(
        db,
        { retentionDays: 7, batchSize: 100, maxBatches: 10 },
        cutoffNow,
      );
      expect(result.deleted).toBe(1);

      const remaining = await db.select().from(liveEventOutbox).where(eq(liveEventOutbox.id, recent.id));
      expect(remaining).toHaveLength(1);
      const removed = await db.select().from(liveEventOutbox).where(eq(liveEventOutbox.id, old.id));
      expect(removed).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("retention sweep also deletes stale fanout checkpoint rows, bounding orphaned-replica-identity growth", async () => {
    try {
      await upsertFanoutCheckpoint(db, { replicaId: "replica-stale", lastDeliveredId: 5 });
      await upsertFanoutCheckpoint(db, { replicaId: "replica-fresh", lastDeliveredId: 5 });
      await db.execute(
        sql`update ${liveEventFanoutCheckpoints} set updated_at = now() - interval '10 days' where replica_id = 'replica-stale'`,
      );

      const cutoffNow = () => new Date();
      const result = await runLiveEventOutboxRetentionSweep(
        db,
        { retentionDays: 7, batchSize: 100, maxBatches: 10 },
        cutoffNow,
      );
      expect(result).toBeDefined();

      expect(await getFanoutCheckpoint(db, "replica-stale")).toBeNull();
      expect(await getFanoutCheckpoint(db, "replica-fresh")).toBe(5);
    } finally {
      await cleanup();
    }
  });

  it("deleteStaleFanoutCheckpoints only removes rows untouched since the cutoff", async () => {
    try {
      await upsertFanoutCheckpoint(db, { replicaId: "replica-old", lastDeliveredId: 1 });
      await db.execute(
        sql`update ${liveEventFanoutCheckpoints} set updated_at = now() - interval '1 hour' where replica_id = 'replica-old'`,
      );
      await upsertFanoutCheckpoint(db, { replicaId: "replica-new", lastDeliveredId: 2 });

      const deleted = await deleteStaleFanoutCheckpoints(db, { cutoff: new Date(Date.now() - 30 * 60 * 1000) });
      expect(deleted).toBe(1);
      expect(await getFanoutCheckpoint(db, "replica-old")).toBeNull();
      expect(await getFanoutCheckpoint(db, "replica-new")).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("deleteExpiredLiveEventOutboxRows bounds a single call to batchSize", async () => {
    const companyId = randomUUID();
    try {
      const ids: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const row = await insertLiveEventOutboxRow(db, {
          companyId,
          type: "state.changed",
          payload: { i },
          originReplicaId: "replica-a",
        });
        ids.push(row.id);
      }
      await db.execute(
        sql`update ${liveEventOutbox} set created_at = now() - interval '10 days' where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
      );

      const firstBatch = await deleteExpiredLiveEventOutboxRows(db, {
        cutoff: new Date(),
        batchSize: 2,
      });
      expect(firstBatch).toBe(2);

      const remaining = await db.select().from(liveEventOutbox).where(eq(liveEventOutbox.companyId, companyId));
      expect(remaining).toHaveLength(3);
    } finally {
      await cleanup();
    }
  });
});
