import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  liveEventOutbox,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { configureLiveEventOutbox, subscribeCompanyLiveEvents } from "../services/live-events.ts";
import {
  clearAllHeartbeatRunRuntimeStatuses,
  getHeartbeatRunRuntimeStatus,
} from "../services/heartbeat-run-runtime-status.ts";

vi.doMock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    type: "process",
    execute: vi.fn(),
    testEnvironment: vi.fn(),
  })),
  listAdapterModelProfiles: vi.fn(() => []),
  runningProcesses: new Map(),
}));

const { heartbeatService } = await import("../services/heartbeat.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat runtime-state tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat runtime state deduplication", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-runtime-state-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    clearAllHeartbeatRunRuntimeStatuses();
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deduplicates concurrent runtime-state creation", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const results = await Promise.all(Array.from({ length: 12 }, () => heartbeat.getRuntimeState(agentId)));

    expect(results.every((row) => row?.agentId === agentId)).toBe(true);

    const rows = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId,
      companyId,
      adapterType: "codex_local",
      stateJson: {},
    });
  });

  it("publishes runtime progress without persisting heartbeat run events", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const [insertedRun] = await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId },
    }).returning();
    const run = insertedRun!;

    const liveEvents: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      liveEvents.push(event);
    });
    try {
      const heartbeat = heartbeatService(db);
      const status = await heartbeat.recordRuntimeProgress(run, {
        phase: "config_sync",
        message: "Syncing workspace to sandbox",
        currentToolName: "bash",
        lastAssistantSnippet: "Inspecting the repository",
        lastEventAt: "2026-06-24T00:00:05.000Z",
      }, issueId);

      expect(status).toMatchObject({
        companyId,
        issueId,
        agentId,
        runId,
        phase: "config_sync",
        message: "Syncing workspace to sandbox",
        currentToolName: "bash",
        lastAssistantSnippet: "Inspecting the repository",
        lastEventAt: new Date("2026-06-24T00:00:05.000Z"),
      });
      expect(heartbeat.decorateActiveRunStatus({
        id: runId,
        companyId,
        agentId,
        issueId,
        status: "running",
      })).toMatchObject({
        currentStatusMessage: "Syncing workspace to sandbox",
        currentToolName: "bash",
        lastAssistantSnippet: "Inspecting the repository",
        lastEventAt: new Date("2026-06-24T00:00:05.000Z"),
      });
      expect(liveEvents).toContainEqual(expect.objectContaining({
        companyId,
        type: "heartbeat.run.progress",
        payload: expect.objectContaining({
          runId,
          agentId,
          issueId,
          phase: "config_sync",
          message: "Syncing workspace to sandbox",
          currentToolName: "bash",
          lastAssistantSnippet: "Inspecting the repository",
          lastEventAt: "2026-06-24T00:00:05.000Z",
        }),
      }));

      const persistedEvents = await db.select().from(heartbeatRunEvents);
      expect(persistedEvents).toHaveLength(0);

      await heartbeat.cancelRun(runId, "test cleanup");
      expect(getHeartbeatRunRuntimeStatus(runId)).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  it("producer wiring: cancelRun's setRunStatus transition actually reaches live-event subscribers via publishLiveEventTx/deliverLiveEventLocally, and durably outboxes the row", async () => {
    // Proves the transactional-outbox wiring end to end through a real
    // producer (setRunStatus, exercised here via cancelRun), not just that
    // domain-event-outbox.ts's functions work when called directly — see
    // adversarial review item "producer wiring tests". The first pass of this
    // test never called configureLiveEventOutbox, so outboxDb stayed null and
    // isOutboxWriteEligible() was unconditionally false — it only proved
    // local delivery, not that a real producer's transaction durably writes
    // the row. Configuring the real outbox here closes that gap.
    configureLiveEventOutbox(db, true);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
    });

    const liveEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => liveEvents.push(event));
    try {
      const heartbeat = heartbeatService(db);
      await heartbeat.cancelRun(runId, "producer wiring test");

      expect(liveEvents).toContainEqual(
        expect.objectContaining({
          companyId,
          type: "heartbeat.run.status",
          payload: expect.objectContaining({ runId, status: "cancelled" }),
        }),
      );

      const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(persisted?.status).toBe("cancelled");

      // cancelRun's internals also flip agent status (a separate, also-
      // allowlisted "agent.status" event) as part of the same cancellation —
      // filter to this event's own type rather than assuming this is the
      // only outboxed row for the company.
      const outboxed = await db
        .select()
        .from(liveEventOutbox)
        .where(
          and(eq(liveEventOutbox.companyId, companyId), eq(liveEventOutbox.type, "heartbeat.run.status")),
        );
      expect(outboxed).toHaveLength(1);
      expect(outboxed[0]!.payload).toMatchObject({ runId, status: "cancelled" });
    } finally {
      unsubscribe();
      // Restore write-disabled so later tests in this file (which never
      // configure the outbox themselves) don't pick up an unexpectedly
      // enabled write path from this test's module-level configuration.
      configureLiveEventOutbox(db, false);
      await db.delete(liveEventOutbox);
    }
  });

  it("ignores late runtime progress after the persisted run is terminal", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const [insertedRun] = await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId },
    }).returning();
    const staleRunningRun = insertedRun!;

    const liveEvents: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      liveEvents.push(event);
    });
    try {
      const heartbeat = heartbeatService(db);
      await heartbeat.recordRuntimeProgress(staleRunningRun, {
        phase: "config_sync",
        message: "Syncing workspace to sandbox",
      }, issueId);

      expect(getHeartbeatRunRuntimeStatus(runId)).toMatchObject({
        runId,
        phase: "config_sync",
      });

      liveEvents.length = 0;
      await db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          finishedAt: new Date("2026-06-24T00:01:00.000Z"),
          updatedAt: new Date("2026-06-24T00:01:00.000Z"),
        })
        .where(eq(heartbeatRuns.id, runId));

      const lateStatus = await heartbeat.recordRuntimeProgress(staleRunningRun, {
        phase: "finalize",
        message: "Finalizing sandbox workspace",
      }, issueId);

      expect(lateStatus).toBeNull();
      expect(getHeartbeatRunRuntimeStatus(runId)).toBeNull();
      expect(liveEvents).not.toContainEqual(expect.objectContaining({
        type: "heartbeat.run.progress",
      }));
      expect(await db.select().from(heartbeatRunEvents)).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });
});
