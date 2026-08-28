import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, liveEventOutbox } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  configureLiveEventOutbox,
  deliverLiveEventLocally,
  GLOBAL_LIVE_EVENT_COMPANY_ID,
  publishGlobalLiveEvent,
  publishLiveEvent,
  publishLiveEventTx,
  subscribeCompanyLiveEvents,
  subscribeGlobalLiveEvents,
} from "./live-events.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("live-events outbox write gating (allowlist, payload cap, redaction, kill switch)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-live-events-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(liveEventOutbox);
    // Restore the default (enabled) state so later tests in this file don't
    // inherit a previous test's kill-switch setting.
    configureLiveEventOutbox(db, true);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("only durably outboxes allowlisted event types; a non-allowlisted type still delivers locally but writes no row", async () => {
    configureLiveEventOutbox(db, true);
    const companyId = randomUUID();

    const received: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => received.push(event));
    try {
      // Allowlisted: durably outboxed.
      publishLiveEvent({ companyId, type: "heartbeat.run.status", payload: { runId: "r1", status: "done" } });
      // Not allowlisted (can carry raw tool output) — local delivery only.
      publishLiveEvent({ companyId, type: "heartbeat.run.log", payload: { line: "hello" } });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(received).toHaveLength(2);
      const rows = await db.select().from(liveEventOutbox).where(eq(liveEventOutbox.companyId, companyId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe("heartbeat.run.status");
    } finally {
      unsubscribe();
    }
  });

  it("caps and truncates an oversized allowlisted payload before it is durably written", async () => {
    configureLiveEventOutbox(db, true);
    const companyId = randomUUID();
    const hugeValue = "x".repeat(20_000);

    publishLiveEvent({ companyId, type: "activity.logged", payload: { action: "issue.updated", note: hugeValue } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = await db.select().from(liveEventOutbox).where(eq(liveEventOutbox.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ truncated: true });
    expect(rows[0]!.payload).not.toHaveProperty("note");
  });

  it("UI contract: an oversized heartbeat.run.status payload keeps runId/agentId/status through truncation, so a run list/card UI can still identify and label the row without a REST fetch", async () => {
    configureLiveEventOutbox(db, true);
    const companyId = randomUUID();
    const runId = randomUUID();
    const agentId = randomUUID();
    const hugeFinalText = "summary text ".repeat(2000); // well over MAX_OUTBOX_PAYLOAD_BYTES once serialized

    publishLiveEvent({
      companyId,
      type: "heartbeat.run.status",
      payload: { runId, agentId, status: "completed", finalText: hugeFinalText },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = await db.select().from(liveEventOutbox).where(eq(liveEventOutbox.companyId, companyId));
    expect(rows).toHaveLength(1);
    // Truncated (the oversized finalText is gone)...
    expect(rows[0]!.payload).toMatchObject({ truncated: true });
    expect(rows[0]!.payload).not.toHaveProperty("finalText");
    // ...but a UI keyed on these fields can still find and label this event.
    expect(rows[0]!.payload).toMatchObject({ runId, agentId, status: "completed" });
  });

  it("redacts known-sensitive payload keys before durably writing an allowlisted event", async () => {
    configureLiveEventOutbox(db, true);
    const companyId = randomUUID();

    publishLiveEvent({
      companyId,
      type: "activity.logged",
      payload: { action: "agent.configured", token: "super-secret", safeField: "ok" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = await db.select().from(liveEventOutbox).where(eq(liveEventOutbox.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ token: "[redacted]", safeField: "ok" });
  });

  it("recursively redacts sensitive keys nested inside a production-shaped activity.logged `details` object, not just top-level payload keys", async () => {
    configureLiveEventOutbox(db, true);
    const companyId = randomUUID();

    // Shaped like a real `activity-log.ts` publication: `details` is an
    // arbitrary, producer-supplied nested object (see
    // `redactActivityDetails`, a domain-level redaction that is not a
    // guarantee a key like `token` can never appear a few levels deep in
    // application metadata).
    publishLiveEvent({
      companyId,
      type: "activity.logged",
      payload: {
        actorType: "agent",
        actorId: randomUUID(),
        action: "external_object.synced",
        entityType: "external_object",
        entityId: randomUUID(),
        details: {
          summary: "synced external object",
          request: {
            headers: { authorization: "Bearer super-secret", accept: "application/json" },
            metadata: { retries: 0, lastError: { stdout: "raw command output", code: 1 } },
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = await db.select().from(liveEventOutbox).where(eq(liveEventOutbox.companyId, companyId));
    expect(rows).toHaveLength(1);
    const details = (rows[0]!.payload as { details: Record<string, unknown> }).details;
    expect(details.summary).toBe("synced external object");
    const request = details.request as Record<string, unknown>;
    expect((request.headers as Record<string, unknown>).authorization).toBe("[redacted]");
    expect((request.headers as Record<string, unknown>).accept).toBe("application/json");
    const metadata = request.metadata as Record<string, unknown>;
    expect((metadata.lastError as Record<string, unknown>).stdout).toBe("[redacted]");
    expect((metadata.lastError as Record<string, unknown>).code).toBe(1);
    expect(metadata.retries).toBe(0);
  });

  it("bounds recursive redaction depth rather than walking an arbitrarily deep payload forever", async () => {
    configureLiveEventOutbox(db, true);
    const companyId = randomUUID();

    let deeplyNested: Record<string, unknown> = { token: "leaf-secret" };
    for (let i = 0; i < 20; i += 1) {
      deeplyNested = { child: deeplyNested };
    }

    publishLiveEvent({
      companyId,
      type: "activity.logged",
      payload: { action: "deep.test", details: deeplyNested },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = await db.select().from(liveEventOutbox).where(eq(liveEventOutbox.companyId, companyId));
    expect(rows).toHaveLength(1);
    // Just proving this terminates and produces a well-formed row — the
    // exact marker string past the depth limit is an implementation detail.
    expect(rows[0]!.payload).toHaveProperty("details");
  });

  it("kill switch (writeEnabled=false) stops the durable write path entirely, while local delivery keeps working", async () => {
    configureLiveEventOutbox(db, false);
    const companyId = randomUUID();

    const received: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => received.push(event));
    try {
      publishLiveEvent({ companyId, type: "heartbeat.run.status", payload: { runId: "r1", status: "done" } });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(received).toHaveLength(1);
      const rows = await db.select().from(liveEventOutbox).where(eq(liveEventOutbox.companyId, companyId));
      expect(rows).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it("publishLiveEventTx: allowlisted event writes a durable row and still returns delivery info; kill switch stops only the write", async () => {
    const companyId = randomUUID();

    configureLiveEventOutbox(db, true);
    const enabledResult = await db.transaction(async (tx) => {
      return publishLiveEventTx(tx, { companyId, type: "heartbeat.run.status", payload: { runId: "r2", status: "running" } });
    });
    expect(enabledResult).toMatchObject({ companyId, type: "heartbeat.run.status" });
    expect(await db.select().from(liveEventOutbox).where(eq(liveEventOutbox.companyId, companyId))).toHaveLength(1);

    configureLiveEventOutbox(db, false);
    const disabledCompanyId = randomUUID();
    const disabledResult = await db.transaction(async (tx) => {
      return publishLiveEventTx(tx, { companyId: disabledCompanyId, type: "heartbeat.run.status", payload: { runId: "r3", status: "running" } });
    });
    // Still returns a deliverable event even though nothing was written.
    expect(disabledResult).toMatchObject({ companyId: disabledCompanyId, type: "heartbeat.run.status" });
    expect(
      await db.select().from(liveEventOutbox).where(eq(liveEventOutbox.companyId, disabledCompanyId)),
    ).toHaveLength(0);
  });

  it("deliverLiveEventLocally and publishLiveEvent share one local id space on the same stream", async () => {
    const companyId = randomUUID();
    const received: Array<{ id: number }> = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => received.push(event));
    try {
      publishLiveEvent({ companyId, type: "agent.status", payload: {} });
      deliverLiveEventLocally({ companyId, type: "heartbeat.run.status", payload: { runId: "r4", status: "done" } });
      publishLiveEvent({ companyId, type: "agent.status", payload: {} });

      expect(received).toHaveLength(3);
      const ids = received.map((e) => e.id);
      // Strictly increasing, drawn from one counter — never two interleaved
      // id spaces (the bug this fixes: a durable-outbox id mixed with the
      // in-memory counter on the same stream).
      expect(ids[1]).toBeGreaterThan(ids[0]!);
      expect(ids[2]).toBeGreaterThan(ids[1]!);
    } finally {
      unsubscribe();
    }
  });

  it("publishGlobalLiveEvent uses the GLOBAL_LIVE_EVENT_COMPANY_ID sentinel consistently for the emitter channel and (when allowlisted) the durable row", async () => {
    configureLiveEventOutbox(db, true);
    const received: unknown[] = [];
    const unsubscribe = subscribeGlobalLiveEvents((event) => received.push(event));
    try {
      publishGlobalLiveEvent({ type: "agent.status", payload: {} });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(received).toHaveLength(1);
      const rows = await db
        .select()
        .from(liveEventOutbox)
        .where(eq(liveEventOutbox.companyId, GLOBAL_LIVE_EVENT_COMPANY_ID));
      expect(rows).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });
});
