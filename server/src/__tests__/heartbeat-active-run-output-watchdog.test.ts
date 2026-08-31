import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS,
  ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
  ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
  recoveryService,
} from "../services/recovery/service.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres active-run output watchdog tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function errorHasPostgresCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === code) return true;
    current = record.cause;
  }
  return false;
}

async function truncateCompaniesWithDeadlockRetry(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
      return;
    } catch (error) {
      if (!errorHasPostgresCode(error, "40P01") || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

describeEmbeddedPostgres("active-run output watchdog", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-active-run-output-watchdog-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await truncateCompaniesWithDeadlockRetry(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRunningRun(opts: {
    now: Date;
    ageMs: number;
    withOutput?: boolean;
    sourceStatus?: "in_progress" | "blocked" | "done" | "cancelled";
    sourceOriginKind?: string;
    sameRunTerminalEvidence?: boolean;
  }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const startedAt = new Date(opts.now.getTime() - opts.ageMs);
    const lastOutputAt = opts.withOutput ? new Date(opts.now.getTime() - 5 * 60 * 1000) : null;
    const sourceStatus = opts.sourceStatus ?? "in_progress";
    const terminalEvidenceAt = new Date(startedAt.getTime() + 10 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Watchdog Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "running",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Long running implementation",
      status: sourceStatus,
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      originKind: opts.sourceOriginKind ?? "manual",
      completedAt: sourceStatus === "done" ? terminalEvidenceAt : null,
      cancelledAt: sourceStatus === "cancelled" ? terminalEvidenceAt : null,
      updatedAt: startedAt,
      createdAt: startedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      lastOutputAt,
      lastOutputSeq: opts.withOutput ? 3 : 0,
      lastOutputStream: opts.withOutput ? "stdout" : null,
      contextSnapshot: { issueId },
      logBytes: 0,
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

    if (opts.sameRunTerminalEvidence) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "agent",
        actorId: coderId,
        agentId: coderId,
        runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: {
          identifier: `${issuePrefix}-1`,
          status: sourceStatus,
          _previous: { status: "in_progress" },
        },
        createdAt: terminalEvidenceAt,
      });
    }

    return { companyId, managerId, coderId, issueId, runId, issuePrefix, startedAt };
  }

  function createRecovery() {
    const enqueueWakeup = vi.fn();
    return { enqueueWakeup, recovery: recoveryService(db, { enqueueWakeup }) };
  }

  async function buildSummary(runId: string, now: Date) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    if (!run) throw new Error(`Missing test run ${runId}`);
    return recoveryService(db, { enqueueWakeup: vi.fn() }).buildRunOutputSilence(run, now);
  }

  async function expectNoReviewArtifacts(input: {
    companyId: string;
    issueId: string;
    coderId: string;
    managerId: string;
  }) {
    const [evaluations, comments, relations, actions, wakes, source, coder, manager] = await Promise.all([
      db.select().from(issues).where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.originKind, "stale_active_run_evaluation"),
      )),
      db.select().from(issueComments).where(eq(issueComments.issueId, input.issueId)),
      db.select().from(issueRelations).where(eq(issueRelations.companyId, input.companyId)),
      db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, input.companyId)),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId)),
      db.select().from(issues).where(eq(issues.id, input.issueId)).then((rows) => rows[0]),
      db.select().from(agents).where(eq(agents.id, input.coderId)).then((rows) => rows[0]),
      db.select().from(agents).where(eq(agents.id, input.managerId)).then((rows) => rows[0]),
    ]);

    expect(evaluations).toHaveLength(0);
    expect(comments).toHaveLength(0);
    expect(relations).toHaveLength(0);
    expect(actions).toHaveLength(0);
    expect(wakes).toHaveLength(0);
    expect(source?.assigneeAgentId).toBe(input.coderId);
    expect(coder?.status).toBe("running");
    expect(manager?.status).toBe("idle");
  }

  it.each([
    {
      level: "suspicious" as const,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    },
    {
      level: "critical" as const,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
    },
  ])("surfaces $level silence without creating recovery work", async ({ level, ageMs }) => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedRunningRun({ now, ageMs });
    const { enqueueWakeup, recovery } = createRecovery();

    await expect(recovery.buildRunOutputSilence(
      (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)))[0]!,
      now,
    )).resolves.toMatchObject({
      level,
      silenceAgeMs: ageMs,
      suspicionThresholdMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
      criticalThresholdMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
      evaluationIssueId: null,
      evaluationIssueIdentifier: null,
      evaluationIssueAssigneeAgentId: null,
    });

    const first = await recovery.scanSilentActiveRuns({ now, companyId: seeded.companyId });
    const second = await recovery.scanSilentActiveRuns({ now, companyId: seeded.companyId });
    expect(first).toMatchObject({ scanned: 1, created: 0, existing: 0, escalated: 0, skipped: 1 });
    expect(second).toMatchObject({ scanned: 1, created: 0, existing: 0, escalated: 0, skipped: 1 });
    expect(first.evaluationIssueIds).toEqual([]);
    expect(second.evaluationIssueIds).toEqual([]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    await expectNoReviewArtifacts(seeded);

    const decisions = await db
      .select()
      .from(heartbeatRunWatchdogDecisions)
      .where(eq(heartbeatRunWatchdogDecisions.runId, seeded.runId));
    expect(decisions).toHaveLength(0);
  });

  it("keeps blocked and recovery-origin sources artifact-free", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const blocked = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      sourceStatus: "blocked",
    });
    const recursive = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      sourceOriginKind: "stale_active_run_evaluation",
    });
    const { enqueueWakeup, recovery } = createRecovery();

    await expect(recovery.scanSilentActiveRuns({ now, companyId: blocked.companyId }))
      .resolves.toMatchObject({ created: 0, skipped: 1 });
    await expect(recovery.scanSilentActiveRuns({ now, companyId: recursive.companyId }))
      .resolves.toMatchObject({ created: 0, skipped: 1 });
    await expectNoReviewArtifacts(blocked);

    const recursiveIssues = await db.select().from(issues).where(eq(issues.companyId, recursive.companyId));
    expect(recursiveIssues).toHaveLength(1);
    expect(recursiveIssues[0]?.id).toBe(recursive.issueId);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, recursive.issueId))).toHaveLength(0);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, recursive.companyId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, recursive.companyId))).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("stores board snooze decisions directly on the run", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
    });
    const { recovery } = createRecovery();
    const snoozedUntil = new Date(now.getTime() + 60 * 60 * 1000);

    const decision = await recovery.recordWatchdogDecision({
      runId: seeded.runId,
      actor: { type: "board" },
      decision: "snooze",
      snoozedUntil,
      reason: "Known quiet compile",
      now,
    });
    expect(decision).toMatchObject({
      runId: seeded.runId,
      evaluationIssueId: null,
      decision: "snooze",
      snoozedUntil,
    });
    await expect(buildSummary(seeded.runId, now)).resolves.toMatchObject({
      level: "snoozed",
      snoozedUntil,
      evaluationIssueId: null,
    });
    await expect(buildSummary(seeded.runId, new Date(snoozedUntil.getTime() + 1))).resolves.toMatchObject({
      level: "critical",
      snoozedUntil: null,
    });
    await expectNoReviewArtifacts(seeded);
  });

  it("re-arms board continue decisions after 30 minutes without creating artifacts", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const { enqueueWakeup, recovery } = createRecovery();
    const decision = await recovery.recordWatchdogDecision({
      runId: seeded.runId,
      actor: { type: "board" },
      decision: "continue",
      reason: "Keep watching this run",
      now,
    });
    const rearmAt = new Date(now.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS);

    expect(decision.evaluationIssueId).toBeNull();
    expect(decision.snoozedUntil?.toISOString()).toBe(rearmAt.toISOString());
    await expect(buildSummary(seeded.runId, new Date(rearmAt.getTime() - 1))).resolves.toMatchObject({
      level: "snoozed",
      evaluationIssueId: null,
    });
    await expect(buildSummary(seeded.runId, new Date(rearmAt.getTime() + 1))).resolves.toMatchObject({
      level: "suspicious",
      evaluationIssueId: null,
    });
    await expect(recovery.scanSilentActiveRuns({ now: new Date(rearmAt.getTime() - 1), companyId: seeded.companyId }))
      .resolves.toMatchObject({ snoozed: 1, created: 0 });
    await expect(recovery.scanSilentActiveRuns({ now: new Date(rearmAt.getTime() + 1), companyId: seeded.companyId }))
      .resolves.toMatchObject({ skipped: 1, created: 0 });
    expect(enqueueWakeup).not.toHaveBeenCalled();
    await expectNoReviewArtifacts(seeded);
  });

  it("permanently suppresses a run after a board false-positive decision", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const { enqueueWakeup, recovery } = createRecovery();

    const decision = await recovery.recordWatchdogDecision({
      runId: seeded.runId,
      actor: { type: "board" },
      decision: "dismissed_false_positive",
      reason: "This run is expected to remain quiet",
      now,
    });
    expect(decision.evaluationIssueId).toBeNull();
    await expect(buildSummary(seeded.runId, now)).resolves.toMatchObject({
      level: "not_applicable",
      snoozedUntil: null,
      evaluationIssueId: null,
    });
    const muchLater = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await expect(buildSummary(seeded.runId, muchLater)).resolves.toMatchObject({
      level: "not_applicable",
      snoozedUntil: null,
    });
    await expect(recovery.scanSilentActiveRuns({ now: muchLater, companyId: seeded.companyId }))
      .resolves.toMatchObject({ created: 0, skipped: 1 });
    expect(enqueueWakeup).not.toHaveBeenCalled();
    await expectNoReviewArtifacts(seeded);
  });

  it("folds a terminal source with same-run evidence without creating review work", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      sourceStatus: "done",
      sameRunTerminalEvidence: true,
    });
    const { enqueueWakeup, recovery } = createRecovery();

    const result = await recovery.scanSilentActiveRuns({ now, companyId: seeded.companyId });
    expect(result).toMatchObject({ created: 0, folded: 1, skipped: 0 });
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    const [source] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, seeded.coderId));
    expect(run?.status).toBe("succeeded");
    expect(run?.resultJson).toMatchObject({
      sourceResolvedWatchdogFold: {
        sourceIssueId: seeded.issueId,
        sourceIssueStatus: "done",
        evaluationIssueId: null,
        cleanup: { outcome: "no_process_metadata" },
      },
    });
    expect(source?.executionRunId).toBeNull();
    expect(agent?.status).toBe("idle");
    expect(await db.select().from(issues).where(and(
      eq(issues.companyId, seeded.companyId),
      eq(issues.originKind, "stale_active_run_evaluation"),
    ))).toHaveLength(0);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, seeded.companyId))).toHaveLength(0);
  });

  it("does not fold or create review work for a terminal source without same-run evidence", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      sourceStatus: "done",
    });
    const { enqueueWakeup, recovery } = createRecovery();

    await expect(recovery.scanSilentActiveRuns({ now, companyId: seeded.companyId }))
      .resolves.toMatchObject({ created: 0, folded: 0, skipped: 1 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(run?.status).toBe("running");
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issues).where(and(
      eq(issues.companyId, seeded.companyId),
      eq(issues.originKind, "stale_active_run_evaluation"),
    ))).toHaveLength(0);
  });

  it("folds existing legacy evaluation and recovery rows idempotently", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      sourceStatus: "done",
      sameRunTerminalEvidence: true,
    });
    const evaluationIssueId = randomUUID();
    await db.insert(issues).values({
      id: evaluationIssueId,
      companyId: seeded.companyId,
      title: "Existing stale evaluation",
      status: "todo",
      priority: "high",
      assigneeAgentId: seeded.managerId,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      originKind: "stale_active_run_evaluation",
      originId: seeded.runId,
      originRunId: seeded.runId,
      originFingerprint: `stale_active_run:${seeded.companyId}:${seeded.runId}`,
    });
    await db.insert(issueRelations).values({
      companyId: seeded.companyId,
      issueId: evaluationIssueId,
      relatedIssueId: seeded.issueId,
      type: "blocks",
    });
    await db.insert(issueRecoveryActions).values({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      recoveryIssueId: evaluationIssueId,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "agent",
      ownerAgentId: seeded.managerId,
      cause: "active_run_watchdog",
      fingerprint: `active-run-watchdog:${seeded.companyId}:${seeded.runId}:${seeded.issueId}`,
      evidence: { runId: seeded.runId },
      nextAction: "Review stale active run",
    });
    const { recovery } = createRecovery();

    await expect(recovery.scanSilentActiveRuns({ now, companyId: seeded.companyId }))
      .resolves.toMatchObject({ created: 0, folded: 1 });
    await expect(recovery.scanSilentActiveRuns({ now, companyId: seeded.companyId }))
      .resolves.toMatchObject({ scanned: 0, created: 0, folded: 0 });
    const [evaluation] = await db.select().from(issues).where(eq(issues.id, evaluationIssueId));
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId));
    expect(evaluation?.status).toBe("done");
    expect(action).toMatchObject({ status: "resolved", outcome: "false_positive" });
    expect(await db.select().from(heartbeatRunWatchdogDecisions).where(eq(
      heartbeatRunWatchdogDecisions.runId,
      seeded.runId,
    ))).toHaveLength(1);
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, seeded.runId))).toHaveLength(1);
  });

  it("keeps open legacy evaluations readable without refreshing or reprioritizing them", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
    });
    const evaluationIssueId = randomUUID();
    const evaluationUpdatedAt = new Date("2026-04-20T12:00:00.000Z");
    await db.insert(issues).values({
      id: evaluationIssueId,
      companyId: seeded.companyId,
      title: "Legacy silent-run evaluation",
      status: "todo",
      priority: "medium",
      assigneeAgentId: seeded.managerId,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      originKind: "stale_active_run_evaluation",
      originId: seeded.runId,
      originRunId: seeded.runId,
      originFingerprint: `stale_active_run:${seeded.companyId}:${seeded.runId}`,
      updatedAt: evaluationUpdatedAt,
    });
    const { enqueueWakeup, recovery } = createRecovery();

    await expect(buildSummary(seeded.runId, now)).resolves.toMatchObject({
      level: "critical",
      evaluationIssueId,
      evaluationIssueIdentifier: `${seeded.issuePrefix}-2`,
      evaluationIssueAssigneeAgentId: seeded.managerId,
    });
    await expect(recovery.scanSilentActiveRuns({ now, companyId: seeded.companyId }))
      .resolves.toMatchObject({ created: 0, existing: 1, escalated: 0 });
    const [evaluation] = await db.select().from(issues).where(eq(issues.id, evaluationIssueId));
    expect(evaluation).toMatchObject({ status: "todo", priority: "medium", assigneeAgentId: seeded.managerId });
    expect(evaluation?.updatedAt.toISOString()).toBe(evaluationUpdatedAt.toISOString());
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, evaluationIssueId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, seeded.companyId))).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    await expect(recovery.recordWatchdogDecision({
      runId: seeded.runId,
      actor: { type: "agent", agentId: seeded.managerId },
      decision: "continue",
      evaluationIssueId,
      reason: "Resolve through the legacy review",
      now,
    })).resolves.toMatchObject({ evaluationIssueId, createdByAgentId: seeded.managerId });
    await expect(recovery.recordWatchdogDecision({
      runId: seeded.runId,
      actor: { type: "agent", agentId: randomUUID() },
      decision: "continue",
      evaluationIssueId,
      reason: "Not assigned",
      now,
    })).rejects.toMatchObject({ status: 403 });
  });

  it("does not recreate or auto-dismiss a closed legacy evaluation", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const evaluationIssueId = randomUUID();
    await db.insert(issues).values({
      id: evaluationIssueId,
      companyId: seeded.companyId,
      title: "Closed legacy evaluation",
      status: "done",
      priority: "medium",
      assigneeAgentId: seeded.managerId,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      originKind: "stale_active_run_evaluation",
      originId: seeded.runId,
      originRunId: seeded.runId,
      originFingerprint: `stale_active_run:${seeded.companyId}:${seeded.runId}`,
    });
    const { recovery } = createRecovery();

    await expect(recovery.scanSilentActiveRuns({ now, companyId: seeded.companyId }))
      .resolves.toMatchObject({ created: 0, existing: 0, skipped: 1 });
    expect(await db.select().from(issues).where(eq(issues.companyId, seeded.companyId))).toHaveLength(2);
    expect(await db.select().from(heartbeatRunWatchdogDecisions).where(eq(
      heartbeatRunWatchdogDecisions.runId,
      seeded.runId,
    ))).toHaveLength(0);
  });

  it("ignores healthy runs that produced recent output", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      withOutput: true,
    });
    const { recovery } = createRecovery();

    await expect(buildSummary(seeded.runId, now)).resolves.toMatchObject({ level: "ok" });
    await expect(recovery.scanSilentActiveRuns({ now, companyId: seeded.companyId }))
      .resolves.toMatchObject({ scanned: 0, created: 0 });
  });

  it("buildRunOutputSilenceMap matches per-run buildRunOutputSilence results for a batch of runs", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const suspicious = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const { companyId, managerId, coderId, issuePrefix } = suspicious;
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    // Second run in the same company: aged past the critical threshold, later snoozed
    // so the batch exercises the "snoozed" branch alongside "suspicious" and "ok".
    const criticalIssueId = randomUUID();
    const criticalRunId = randomUUID();
    const criticalStartedAt = new Date(now.getTime() - (ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000));
    await db.insert(issues).values({
      id: criticalIssueId,
      companyId,
      title: "Second long running implementation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
      originKind: "manual",
      updatedAt: criticalStartedAt,
      createdAt: criticalStartedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: criticalRunId,
      companyId,
      agentId: coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: criticalStartedAt,
      processStartedAt: criticalStartedAt,
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      contextSnapshot: { issueId: criticalIssueId },
      logBytes: 0,
    });
    await db.update(issues).set({ executionRunId: criticalRunId }).where(eq(issues.id, criticalIssueId));

    // Third run in the same company: recent output, so it stays "ok".
    const okIssueId = randomUUID();
    const okRunId = randomUUID();
    const okStartedAt = new Date(now.getTime() - (ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000));
    const okLastOutputAt = new Date(now.getTime() - 5 * 60 * 1000);
    await db.insert(issues).values({
      id: okIssueId,
      companyId,
      title: "Third noisy implementation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
      originKind: "manual",
      updatedAt: okStartedAt,
      createdAt: okStartedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: okRunId,
      companyId,
      agentId: coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: okStartedAt,
      processStartedAt: okStartedAt,
      lastOutputAt: okLastOutputAt,
      lastOutputSeq: 3,
      lastOutputStream: "stdout",
      contextSnapshot: { issueId: okIssueId },
      logBytes: 0,
    });
    await db.update(issues).set({ executionRunId: okRunId }).where(eq(issues.id, okIssueId));

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(scan.created).toBe(2);

    const criticalEvaluationIssueId = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, "stale_active_run_evaluation"),
        eq(issues.originId, criticalRunId),
      ))
      .then((rows) => rows[0]?.id);
    expect(criticalEvaluationIssueId).toBeTruthy();

    const snoozedUntil = new Date(now.getTime() + 60 * 60 * 1000);
    await recovery.recordWatchdogDecision({
      runId: criticalRunId,
      actor: { type: "agent", agentId: managerId },
      decision: "snooze",
      evaluationIssueId: criticalEvaluationIssueId,
      reason: "Investigating separately",
      snoozedUntil,
    });

    const runs = [
      {
        id: suspicious.runId,
        companyId,
        status: "running" as const,
        lastOutputAt: null,
        lastOutputSeq: 0,
        lastOutputStream: null,
        processStartedAt: new Date(now.getTime() - (ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000)),
        startedAt: new Date(now.getTime() - (ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000)),
        createdAt: new Date(now.getTime() - (ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000)),
      },
      {
        id: criticalRunId,
        companyId,
        status: "running" as const,
        lastOutputAt: null,
        lastOutputSeq: 0,
        lastOutputStream: null,
        processStartedAt: criticalStartedAt,
        startedAt: criticalStartedAt,
        createdAt: criticalStartedAt,
      },
      {
        id: okRunId,
        companyId,
        status: "running" as const,
        lastOutputAt: okLastOutputAt,
        lastOutputSeq: 3,
        lastOutputStream: "stdout" as const,
        processStartedAt: okStartedAt,
        startedAt: okStartedAt,
        createdAt: okStartedAt,
      },
    ];

    const batched = await recovery.buildRunOutputSilenceMap(companyId, runs, now);
    expect(batched.size).toBe(3);

    for (const run of runs) {
      const singular = await recovery.buildRunOutputSilence(run, now);
      expect(batched.get(run.id)).toEqual(singular);
    }

    expect(batched.get(suspicious.runId)?.level).toBe("suspicious");
    expect(batched.get(criticalRunId)?.level).toBe("snoozed");
    expect(batched.get(okRunId)?.level).toBe("ok");
  });

  it("resolves the same evaluation via buildRunOutputSilence and buildRunOutputSilenceMap when a run has multiple open stale-run evaluation issues", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, coderId, runId, issuePrefix } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    // `issues_active_stale_run_evaluation_uq` normally guarantees at most one open
    // evaluation per run. Drop it for this test only, to reproduce the multi-row
    // state the single-run and batch lookups must resolve identically regardless
    // of scan order.
    await db.execute(sql.raw(`DROP INDEX IF EXISTS issues_active_stale_run_evaluation_uq`));

    const olderEvaluationId = randomUUID();
    const newerEvaluationId = randomUUID();
    try {
      const olderUpdatedAt = new Date(now.getTime() - 30 * 60 * 1000);
      await db.insert(issues).values({
        id: olderEvaluationId,
        companyId,
        title: "Review silent active run (older)",
        status: "todo",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 90,
        identifier: `${issuePrefix}-90`,
        originKind: "stale_active_run_evaluation",
        originId: runId,
        updatedAt: olderUpdatedAt,
        createdAt: olderUpdatedAt,
      });

      const newerUpdatedAt = new Date(now.getTime() - 5 * 60 * 1000);
      await db.insert(issues).values({
        id: newerEvaluationId,
        companyId,
        title: "Review silent active run (newer)",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: coderId,
        issueNumber: 91,
        identifier: `${issuePrefix}-91`,
        originKind: "stale_active_run_evaluation",
        originId: runId,
        updatedAt: newerUpdatedAt,
        createdAt: newerUpdatedAt,
      });

      const run = {
        id: runId,
        companyId,
        status: "running" as const,
        lastOutputAt: null,
        lastOutputSeq: 0,
        lastOutputStream: null,
        processStartedAt: new Date(now.getTime() - (ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000)),
        startedAt: new Date(now.getTime() - (ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000)),
        createdAt: new Date(now.getTime() - (ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000)),
      };

      const singular = await recovery.buildRunOutputSilence(run, now);
      const batched = await recovery.buildRunOutputSilenceMap(companyId, [run], now);

      expect(singular.evaluationIssueId).toBe(newerEvaluationId);
      expect(batched.get(run.id)).toEqual(singular);
    } finally {
      // This test intentionally left two open evaluation issues for the same
      // run, which the dropped index normally forbids. Clear them before
      // recreating the index, or CREATE UNIQUE INDEX fails on the existing
      // violation.
      await db.delete(issues).where(eq(issues.id, olderEvaluationId));
      await db.delete(issues).where(eq(issues.id, newerEvaluationId));
      // Restore the partial unique index so later tests in this file (and any
      // appended after this one) still run under the real schema constraint.
      await db.execute(
        sql.raw(`
          CREATE UNIQUE INDEX IF NOT EXISTS issues_active_stale_run_evaluation_uq
            ON issues USING btree (company_id, origin_kind, origin_id)
            WHERE origin_kind = 'stale_active_run_evaluation'
              AND origin_id IS NOT NULL
              AND hidden_at IS NULL
              AND status NOT IN ('done', 'cancelled')
        `),
      );
    }
  });
});
