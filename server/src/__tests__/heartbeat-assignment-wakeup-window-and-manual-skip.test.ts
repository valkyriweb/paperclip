import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// Prevent claimed runs from spawning a real adapter process — these tests
// only assert on wakeup acceptance/queueing state, not adapter execution.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Assignment wakeup window test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres assignment-wakeup window/manual-skip tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("assignment wakeup window gating and manual skip reasons", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-assignment-window-manual-skip-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    // Wakeup does not await full run execution, so give in-flight runs a
    // chance to finish (and stop writing company_skills/environment_leases
    // rows) before cleanup deletes their parent rows.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const activeRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "running"));
      if (activeRuns.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // A run leaving "running" status can still have trailing async work (e.g.
    // durable failure writes) land a moment later; drain the service's tracked
    // wakeups/executions before deleting their parent rows.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await heartbeatService(db).drainActiveRunExecutions();
    // A trailing fire-and-forget lifecycle event can race the first event
    // cleanup. Retry the parent delete after clearing events so this suite's
    // cleanup is deterministic under the full test runner.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 19 || (error as { code?: string }).code !== "23503") throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(environmentLeases);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    // Fire-and-forget wakeup/execution failure paths can still land a durable
    // agentWakeupRequests write after the delete above, so clear it again
    // immediately before the FK-dependent agents delete.
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(runtimeConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: ownerUserId,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig,
      permissions: {},
    });

    return { companyId, agentId, ownerUserId, issuePrefix };
  }

  it("queues an assignment wakeup outside the timer window when wakeOnDemand=true", async () => {
    const { companyId, agentId, ownerUserId, issuePrefix } = await seedCompanyAndAgent({
      heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Newly assigned",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: ownerUserId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });

    // Assignment wakes fire outside the periodic timer window; wakeOnDemand=true
    // must let them through rather than being suppressed like a timer tick would be.
    expect(run).not.toBeNull();
    expect(run?.invocationSource).toBe("assignment");

    const request_ = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));
    expect(request_).toHaveLength(1);
    expect(request_[0]?.status).not.toBe("skipped");
  });

  it("keeps a running agent's assignment wakeup for a different issue queued, honoring maxConcurrentRuns", async () => {
    const { companyId, agentId, ownerUserId, issuePrefix } = await seedCompanyAndAgent({
      heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
    });
    const runningIssueId = randomUUID();
    const runningRunId = randomUUID();
    const newIssueId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: runningIssueId, taskId: runningIssueId },
    });
    await db.insert(issues).values([
      {
        id: runningIssueId,
        companyId,
        title: "Already running",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        executionRunId: runningRunId,
        executionAgentNameKey: "coder",
        executionLockedAt: new Date(),
        responsibleUserId: ownerUserId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: newIssueId,
        companyId,
        title: "Freshly assigned",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: ownerUserId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    runningProcesses.set(runningRunId, { child: {} as never, graceSec: 0, processGroupId: null });

    const heartbeat = heartbeatService(db);
    const queuedRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: newIssueId },
      contextSnapshot: { issueId: newIssueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });

    // A different-issue assignment wake must not be dropped just because the
    // agent's single concurrency slot is already held by another issue's run.
    expect(queuedRun).not.toBeNull();
    expect(queuedRun?.status).toBe("queued");
    expect(queuedRun?.id).not.toBe(runningRunId);

    const runs = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.id === runningRunId)?.status).toBe("running");
    // maxConcurrentRuns=1 with the slot already held means the queued run must
    // NOT have been promoted to running by the same wakeup() call.
    expect(runs.find((r) => r.id === queuedRun?.id)?.status).toBe("queued");
  });

  it("returns the exact stored skip reason for a manual wakeup instead of the generic message", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeat: { wakeOnDemand: false },
    });

    const app = createApp(db, boardActor(companyId));
    const res = await request(app)
      .post(`/api/agents/${agentId}/wakeup`)
      .send({ source: "on_demand" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("skipped");
    // Before the fix this always came back as the generic "wakeup_skipped"
    // reason, hiding the actual cause (heartbeat.wakeOnDemand.disabled) from
    // the caller even though the durable record stored the precise reason.
    expect(res.body.reason).toBe("heartbeat.wakeOnDemand.disabled");
    expect(res.body.message).not.toBe("Wakeup was skipped.");

    const stored = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.reason).toBe("heartbeat.wakeOnDemand.disabled");
  });

  it("falls back to the agent's most recent skip reason when a repeat same-day cap block writes no new row", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeat: { wakeOnDemand: true, maxDailyRuns: 0 },
    });

    const app = createApp(db, boardActor(companyId));
    const first = await request(app).post(`/api/agents/${agentId}/wakeup`).send({ source: "on_demand" });
    expect(first.status).toBe(202);
    expect(first.body.status).toBe("skipped");
    expect(first.body.reason).toBe("heartbeat.daily_run_limit");

    // The daily-cap block dedupes: a second same-day skip for the same
    // reason writes no new agentWakeupRequests row, so this request's own
    // idempotency key matches nothing directly.
    const second = await request(app).post(`/api/agents/${agentId}/wakeup`).send({ source: "on_demand" });
    expect(second.status).toBe(202);
    expect(second.body.status).toBe("skipped");
    // Before the fix, a miss on the exact idempotency key silently fell back
    // to the generic "wakeup_skipped" message even though the precise reason
    // was durably recorded moments earlier under a different key.
    expect(second.body.reason).toBe("heartbeat.daily_run_limit");

    const rows = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));
    expect(rows).toHaveLength(1);
  });
});
