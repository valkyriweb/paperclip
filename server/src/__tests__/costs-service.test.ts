import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql as sqlTag } from "drizzle-orm";
import {
  createDb,
  companies,
  agents,
  activityLog,
  approvals,
  budgetPolicies,
  budgetIncidents,
  costEvents,
  financeEvents,
  heartbeatRuns,
  issues,
  modelPricing,
  projects,
} from "@paperclipai/db";
import { costService } from "../services/costs.ts";
import { financeService } from "../services/finance.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function makeDb(overrides: Record<string, unknown> = {}) {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue([]),
  };

  const thenableChain = Object.assign(Promise.resolve([]), selectChain);

  return {
    select: vi.fn().mockReturnValue(thenableChain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    ...overrides,
  };
}

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  cancelBudgetScopeWork: vi.fn().mockResolvedValue(undefined),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFetchAllQuotaWindows = vi.hoisted(() => vi.fn());
const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ spendCents: 0 }),
  byAgent: vi.fn().mockResolvedValue([]),
  byAgentModel: vi.fn().mockResolvedValue([]),
  byProvider: vi.fn().mockResolvedValue([]),
  byBiller: vi.fn().mockResolvedValue([]),
  issueTreeSummary: vi.fn().mockResolvedValue({
    issueId: "issue-1",
    issueCount: 1,
    includeDescendants: true,
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    runCount: 0,
    runtimeMs: 0,
  }),
  windowSpend: vi.fn().mockResolvedValue([]),
  byProject: vi.fn().mockResolvedValue([]),
}));
const mockFinanceService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ debitCents: 0, creditCents: 0, netCents: 0, estimatedDebitCents: 0, eventCount: 0 }),
  byBiller: vi.fn().mockResolvedValue([]),
  byKind: vi.fn().mockResolvedValue([]),
  list: vi.fn().mockResolvedValue([]),
}));
const mockBudgetService = vi.hoisted(() => ({
  overview: vi.fn().mockResolvedValue({
    companyId: "company-1",
    policies: [],
    activeIncidents: [],
    pausedAgentCount: 0,
    pausedProjectCount: 0,
    pendingApprovalCount: 0,
  }),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    budgetService: () => mockBudgetService,
    costService: () => mockCostService,
    financeService: () => mockFinanceService,
    companyService: () => mockCompanyService,
    agentService: () => mockAgentService,
    issueService: () => mockIssueService,
    heartbeatService: () => mockHeartbeatService,
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/quota-windows.js", () => ({
    fetchAllQuotaWindows: mockFetchAllQuotaWindows,
  }));
}

async function createApp() {
  const [{ costRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/costs.js")>("../routes/costs.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
    next();
  });
  app.use("/api", costRoutes(makeDb() as any));
  app.use(errorHandler);
  return app;
}

async function createAppWithActor(actor: any) {
  const [{ costRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/costs.js")>("../routes/costs.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", costRoutes(makeDb() as any));
  app.use(errorHandler);
  return app;
}

async function loadCostParsers() {
  const { parseCostDateRange, parseCostLimit } = await import("../routes/costs.js");
  return { parseCostDateRange, parseCostLimit };
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/quota-windows.js");
  vi.doUnmock("../routes/costs.js");
  vi.doUnmock("../middleware/index.js");
  registerModuleMocks();
  vi.clearAllMocks();
  mockCompanyService.update.mockResolvedValue({
    id: "company-1",
    name: "Paperclip",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockAgentService.getById.mockResolvedValue({
    id: "agent-1",
    companyId: "company-1",
    name: "Budget Agent",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockAgentService.update.mockResolvedValue({
    id: "agent-1",
    companyId: "company-1",
    name: "Budget Agent",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockIssueService.getById.mockResolvedValue({
    id: "issue-1",
    companyId: "company-1",
    identifier: "PC1A2-1",
  });
  mockIssueService.getByIdentifier.mockResolvedValue({
    id: "issue-1",
    companyId: "company-1",
    identifier: "PC1A2-1",
  });
  mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
});

describe("cost routes", () => {
  it("accepts valid ISO date strings", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(parseCostDateRange({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T23:59:59.999Z",
    })).toEqual({
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-31T23:59:59.999Z"),
    });
  });

  it("returns 400 for an invalid 'from' date string", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(() => parseCostDateRange({ from: "not-a-date" })).toThrow(/invalid 'from' date/i);
  });

  it("returns 400 for an invalid 'to' date string", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(() => parseCostDateRange({ to: "banana" })).toThrow(/invalid 'to' date/i);
  });

  it("returns finance summary rows for valid requests", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/finance-summary")
      .query({ from: "2026-02-01T00:00:00.000Z", to: "2026-02-28T23:59:59.999Z" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      estimatedDebitCents: 0,
      eventCount: 0,
    });
  });

  it("returns issue subtree cost summaries for issue refs", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/issues/pc1a2-1/cost-summary");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PC1A2-1");
    expect(mockCostService.issueTreeSummary).toHaveBeenCalledWith("company-1", "issue-1", {
      excludeRoot: false,
    });
    expect(res.body).toEqual({
      issueId: "issue-1",
      issueCount: 1,
      includeDescendants: true,
      costCents: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      runCount: 0,
      runtimeMs: 0,
    });
  });

  it("returns 400 for invalid finance event list limits", async () => {
    const { parseCostLimit } = await loadCostParsers();
    expect(() => parseCostLimit({ limit: "0" })).toThrow(/invalid 'limit'/i);
  });

  it("accepts valid finance event list limits", async () => {
    const { parseCostLimit } = await loadCostParsers();
    expect(parseCostLimit({ limit: "25" })).toBe(25);
  });

  it("rejects company budget updates for board users outside the company", async () => {
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/companies/company-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates for board users outside the agent company", async () => {
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates from the target agent without changing the budget policy", async () => {
    const app = await createAppWithActor({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board access required" });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates from another same-company agent without changing the budget policy", async () => {
    const app = await createAppWithActor({
      type: "agent",
      agentId: "agent-2",
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board access required" });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("allows authorized board users to update an agent budget and budget policy", async () => {
    mockAgentService.update.mockResolvedValueOnce({
      id: "agent-1",
      companyId: "company-1",
      name: "Budget Agent",
      budgetMonthlyCents: 2500,
      spentMonthlyCents: 0,
    });
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith("agent-1", { budgetMonthlyCents: 2500 });
    expect(mockBudgetService.upsertPolicy).toHaveBeenCalledWith(
      "company-1",
      {
        scopeType: "agent",
        scopeId: "agent-1",
        amount: 2500,
        windowKind: "calendar_month_utc",
      },
      "board-user",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "user",
        actorId: "board-user",
        agentId: null,
        action: "agent.budget_updated",
        entityType: "agent",
        entityId: "agent-1",
        details: { budgetMonthlyCents: 2500 },
      }),
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cost and finance aggregate overflow handling", () => {
  let db!: ReturnType<typeof createDb>;
  let costs!: ReturnType<typeof costService>;
  let finance!: ReturnType<typeof financeService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-costs-service-");
    db = createDb(tempDb.connectionString);
    costs = costService(db);
    finance = financeService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates cost event sums above int32 without raising Postgres integer overflow", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Overflow Project",
      status: "active",
    });

    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        projectId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 2_000_000_000,
        cachedInputTokens: 0,
        outputTokens: 200_000_000,
        costCents: 2_000_000_000,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        projectId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 2_000_000_000,
        cachedInputTokens: 10,
        outputTokens: 200_000_000,
        costCents: 2_000_000_000,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
      },
    ]);

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };

    const [byAgentRow] = await costs.byAgent(companyId, range);
    const [byProjectRow] = await costs.byProject(companyId, range);
    const [byAgentModelRow] = await costs.byAgentModel(companyId, range);

    expect(byAgentRow?.costCents).toBe(4_000_000_000);
    expect(byAgentRow?.inputTokens).toBe(4_000_000_000);
    expect(byProjectRow?.costCents).toBe(4_000_000_000);
    expect(byAgentModelRow?.costCents).toBe(4_000_000_000);
  });

  it("aggregates issue costs across recursive descendants only", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const grandchildIssueId = randomUUID();
    const siblingIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
      },
      {
        id: grandchildIssueId,
        companyId,
        parentId: childIssueId,
        title: "Grandchild",
        status: "done",
        priority: "medium",
        issueNumber: 3,
        identifier: "TST-3",
      },
      {
        id: siblingIssueId,
        companyId,
        title: "Sibling",
        status: "done",
        priority: "medium",
        issueNumber: 4,
        identifier: "TST-4",
      },
    ]);
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: rootIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 10,
        cachedInputTokens: 1,
        outputTokens: 2,
        costCents: 100,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 20,
        cachedInputTokens: 2,
        outputTokens: 4,
        costCents: 200,
        occurredAt: new Date("2026-04-10T00:01:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: grandchildIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 30,
        cachedInputTokens: 3,
        outputTokens: 6,
        costCents: 300,
        occurredAt: new Date("2026-04-10T00:02:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: siblingIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 40,
        cachedInputTokens: 4,
        outputTokens: 8,
        costCents: 400,
        occurredAt: new Date("2026-04-10T00:03:00.000Z"),
      },
    ]);

    const summary = await costs.issueTreeSummary(companyId, rootIssueId);

    expect(summary).toEqual({
      issueId: rootIssueId,
      issueCount: 3,
      includeDescendants: true,
      costCents: 600,
      inputTokens: 60,
      cachedInputTokens: 6,
      outputTokens: 12,
      runCount: 0,
      runtimeMs: 0,
    });
  });

  it("aggregates run wall-clock duration across the recursive issue tree", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const grandchildIssueId = randomUUID();
    const siblingIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Run Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child",
        status: "in_progress",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
      },
      {
        id: grandchildIssueId,
        companyId,
        parentId: childIssueId,
        title: "Grandchild",
        status: "done",
        priority: "medium",
        issueNumber: 3,
        identifier: "TST-3",
      },
      {
        id: siblingIssueId,
        companyId,
        title: "Sibling",
        status: "done",
        priority: "medium",
        issueNumber: 4,
        identifier: "TST-4",
      },
    ]);

    const linkedViaContextRunId = randomUUID();
    const linkedViaActivityRunId = randomUUID();
    const grandchildRunId = randomUUID();
    const siblingRunId = randomUUID();
    const livePartialRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      // 60s run linked to root via contextSnapshot.issueId
      {
        id: linkedViaContextRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:00:00.000Z"),
        finishedAt: new Date("2026-04-10T00:01:00.000Z"),
        contextSnapshot: { issueId: rootIssueId },
      },
      // 120s run linked to child via activity_log
      {
        id: linkedViaActivityRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:05:00.000Z"),
        finishedAt: new Date("2026-04-10T00:07:00.000Z"),
      },
      // 30s run linked to grandchild
      {
        id: grandchildRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:10:00.000Z"),
        finishedAt: new Date("2026-04-10T00:10:30.000Z"),
        contextSnapshot: { issueId: grandchildIssueId },
      },
      // sibling run NOT under root – should be excluded
      {
        id: siblingRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:20:00.000Z"),
        finishedAt: new Date("2026-04-10T00:21:00.000Z"),
        contextSnapshot: { issueId: siblingIssueId },
      },
      // Still-running run on child (no finishedAt) – should contribute (now - startedAt)
      {
        id: livePartialRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
        startedAt: new Date(Date.now() - 5_000),
        contextSnapshot: { issueId: childIssueId },
      },
    ]);

    await db.insert(activityLog).values({
      companyId,
      runId: linkedViaActivityRunId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: childIssueId,
      details: {},
    });

    const summary = await costs.issueTreeSummary(companyId, rootIssueId);

    expect(summary.issueCount).toBe(3);
    // 3 finished runs in tree (root, child via activity, grandchild) + 1 live run
    expect(summary.runCount).toBe(4);
    // 60s + 120s + 30s = 210s = 210_000ms from finished runs.
    // Live run adds ~5_000ms; allow some slack so the assertion isn't flaky.
    expect(summary.runtimeMs).toBeGreaterThanOrEqual(210_000 + 4_000);
    expect(summary.runtimeMs).toBeLessThan(210_000 + 60_000);

    // excludeRoot drops the root issue's own runs (the 60s contextSnapshot run)
    // while keeping the child + grandchild runs and any live child run.
    const descendantsOnly = await costs.issueTreeSummary(companyId, rootIssueId, {
      excludeRoot: true,
    });
    expect(descendantsOnly.issueCount).toBe(2);
    expect(descendantsOnly.runCount).toBe(3);
    // 120s + 30s = 150s + ~5s live run
    expect(descendantsOnly.runtimeMs).toBeGreaterThanOrEqual(150_000 + 4_000);
    expect(descendantsOnly.runtimeMs).toBeLessThan(150_000 + 60_000);
  });

  it("aggregates finance event sums above int32 without raising Postgres integer overflow", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(financeEvents).values([
      {
        companyId,
        biller: "openai",
        eventKind: "invoice",
        amountCents: 2_000_000_000,
        currency: "USD",
        direction: "debit",
        estimated: false,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        biller: "openai",
        eventKind: "invoice",
        amountCents: 2_000_000_000,
        currency: "USD",
        direction: "debit",
        estimated: true,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
      },
    ]);

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };

    const summary = await finance.summary(companyId, range);
    const [byKindRow] = await finance.byKind(companyId, range);

    expect(summary.debitCents).toBe(4_000_000_000);
    expect(summary.estimatedDebitCents).toBe(2_000_000_000);
    expect(byKindRow?.debitCents).toBe(4_000_000_000);
    expect(byKindRow?.netCents).toBe(4_000_000_000);
  });
});

describeEmbeddedPostgres("costService.createEvent server-side pricing", () => {
  let db!: ReturnType<typeof createDb>;
  let costs!: ReturnType<typeof costService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  const ANTHROPIC_PRICING_EFFECTIVE_AT = new Date("2026-05-01T00:00:00.000Z");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cost-pricing-");
    db = createDb(tempDb.connectionString);
    costs = costService(db);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Pricing Test",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pricing Test Agent",
      role: "engineer",
      status: "active",
      adapterType: "pi_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // Anthropic claude-sonnet-4-6 pricing: \$3/Mtok input, \$15/Mtok output,
    // \$0.30/Mtok cache read, \$3.75/Mtok cache write.
    // CPM micros: 300_000_000 / 1_500_000_000 / 30_000_000 / 375_000_000.
    await db
      .insert(modelPricing)
      .values({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effectiveAt: ANTHROPIC_PRICING_EFFECTIVE_AT,
        inputCpmMicros: 300_000_000,
        cachedInputCpmMicros: 30_000_000,
        cacheWriteCpmMicros: 375_000_000,
        outputCpmMicros: 1_500_000_000,
        source: "test",
      })
      .onConflictDoNothing();
  });

  afterEach(async () => {
    // Order matters — budget_incidents → approvals → budget_policies, then
    // generic tables, then companies last. Q18 replay test creates a hard
    // incident which inserts an approvals row referencing the company.
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
    // Pricing table is shared across cases; deliberately not cleared.
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("computes costCents from model_pricing when caller omits it", async () => {
    const event = await costs.createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 100_000,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
      // costCents intentionally omitted
    } as any);
    // 1M input @ \$3/Mtok = 300¢ = 300 cents; 100k output @ \$15/Mtok = 150¢.
    // Total ≈ 450 cents (\$4.50).
    expect(event.costCents).toBe(450);
  });

  it("transport-aliases claude-bridge to anthropic for pricing lookup", async () => {
    const event = await costs.createEvent(companyId, {
      agentId,
      provider: "claude-bridge",
      biller: "claude-bridge",
      billingType: "metered_api",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
    } as any);
    expect(event.provider).toBe("claude-bridge");
    expect(event.biller).toBe("claude-bridge");
    // Pricing was resolved via the anthropic alias even though the row reports
    // provider=claude-bridge for attribution.
    expect(event.costCents).toBe(300);
  });

  it("subscription_included always forces costCents to 0 regardless of input", async () => {
    const event = await costs.createEvent(companyId, {
      agentId,
      provider: "claude-bridge",
      biller: "claude-bridge",
      billingType: "subscription_included",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
      costCents: 99999, // caller-supplied bogus value, must be ignored
    } as any);
    expect(event.costCents).toBe(0);
  });

  it("trusts a positive caller-supplied costCents over the pricing table", async () => {
    const event = await costs.createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
      costCents: 1234, // legacy heartbeat path: cost already computed upstream
    } as any);
    expect(event.costCents).toBe(1234);
  });

  it("prices cache reads and cache writes separately", async () => {
    const event = await costs.createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      cachedInputTokens: 1_000_000, // \$0.30 = 30c
      cacheCreationInputTokens: 1_000_000, // \$3.75 = 375c
      outputTokens: 0,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
    } as any);
    expect(event.costCents).toBe(30 + 375); // 405
  });

  it("matches pricing rows across dot/dash model-name variants (gpt-5.5 ↔ gpt-5-5)", async () => {
    // Seed the dash-form row that build-pricing-seed.py produces from
    // vendor_model_id="openai/gpt-5.5".
    await db
      .insert(modelPricing)
      .values({
        provider: "openai",
        model: "gpt-5-5", // <-- dash form, as stored by the seed
        effectiveAt: new Date("2026-05-01T00:00:00.000Z"),
        inputCpmMicros: 125_000_000, // \$1.25/Mtok input
        cachedInputCpmMicros: 12_500_000, // \$0.125/Mtok cache read
        cacheWriteCpmMicros: 0,
        outputCpmMicros: 1_000_000_000, // \$10/Mtok output
        source: "test",
      })
      .onConflictDoNothing();

    // Emitter sends the dot form (e.g. Multica forwarder relaying Pi's
    // model name verbatim). Pricing lookup must collapse `.` to `-` and
    // match the seed row.
    const dotForm = await costs.createEvent(companyId, {
      agentId,
      provider: "openai",
      biller: "multica",
      billingType: "metered_api",
      model: "gpt-5.5", // <-- dot form on the wire
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 100_000,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
    } as any);
    // 1M input @ \$1.25 = 125¢; 100k output @ \$10/Mtok = 100¢; total 225¢.
    expect(dotForm.costCents).toBe(225);

    // Emitter sends the dash form (e.g. heartbeat path, already-normalized
    // model registries). Same lookup must still match.
    const dashForm = await costs.createEvent(companyId, {
      agentId,
      provider: "openai",
      biller: "multica",
      billingType: "metered_api",
      model: "gpt-5-5", // <-- dash form on the wire
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 100_000,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
    } as any);
    expect(dashForm.costCents).toBe(225);
  });

  it("falls back to 0 when no pricing row matches", async () => {
    const event = await costs.createEvent(companyId, {
      agentId,
      provider: "some-new-provider",
      biller: "some-new-provider",
      billingType: "metered_api",
      model: "unknown-model",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
    } as any);
    expect(event.costCents).toBe(0);
  });

  it("replays an idempotency-keyed event onto the same row (ON CONFLICT DO UPDATE)", async () => {
    const idempotencyKey = `bridge:test-session:42`;
    const first = await costs.createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-sonnet-4-6",
      inputTokens: 500_000,
      outputTokens: 50_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
      idempotencyKey,
    } as any);
    expect(first.costCents).toBe(225); // 500k * 3 + 50k * 15 = 150 + 75 = 225c

    // Same idempotency key, different token counts (e.g. caller computed
    // final numbers after streaming): row is updated, not duplicated.
    const second = await costs.createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
      idempotencyKey,
    } as any);
    expect(second.id).toBe(first.id);
    expect(second.inputTokens).toBe(1_000_000);
    expect(second.costCents).toBe(450);

    const allRows = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(allRows).toHaveLength(1);
  });

  it("server-side classifier fills metered_api when caller omits billingType (anthropic)", async () => {
    // External emitters (Multica forwarder, Pi extension, P4b watcher) POST
    // tokens without billingType. Server-side classifier must set metered_api
    // for known metered providers so G2 holds (no `unknown` rows from a known
    // biller). Substream G2.
    const event = await costs.createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      // billingType intentionally omitted
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
      idempotencyKey: `classifier-anthropic-1`,
    } as any);
    expect(event.billingType).toBe("metered_api");
    expect(event.costCents).toBe(300); // 1M * $3/Mtok = 300¢
  });

  it("server-side classifier fills metered_api when caller sends unknown (openai)", async () => {
    const event = await costs.createEvent(companyId, {
      agentId,
      provider: "openai",
      biller: "openai",
      billingType: "unknown",
      model: "gpt-5",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
      idempotencyKey: `classifier-openai-1`,
    } as any);
    expect(event.billingType).toBe("metered_api");
  });

  it("server-side classifier respects explicit billingType from caller", async () => {
    // claude-bridge emitter sets billingType=subscription_included explicitly
    // when OAuth is in use. Server must NOT downgrade that to metered_api just
    // because the provider (anthropic) lives in the metered set.
    const event = await costs.createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "claude-bridge",
      billingType: "subscription_included",
      model: "claude-sonnet-4-6",
      inputTokens: 100_000,
      outputTokens: 50_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
      idempotencyKey: `classifier-bridge-1`,
    } as any);
    expect(event.billingType).toBe("subscription_included");
    expect(event.costCents).toBe(0); // subscription override
  });

  it("Q18: replay of same idempotency_key does NOT re-evaluate budget (no duplicate activity log)", async () => {
    // Q18 spec: gate evaluateCostEvent on inserted=true. Replays carry the
    // same final usage numbers from every emitter we ship, so re-evaluating
    // wastes work AND spams activity_log with duplicate threshold-crossed
    // entries (createIncidentIfNeeded itself is dedup-safe, but the log
    // write is unconditional in the evaluator).
    //
    // Set a $1 hard-stop on the agent, post a $3 cost event with a stable
    // idempotency_key (crosses both thresholds), assert one of each activity
    // log row, then replay the SAME key and assert no new rows.
    const policyId = randomUUID();
    await db.insert(budgetPolicies).values({
      id: policyId,
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100, // $1 hard-stop
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const idempotencyKey = `q18-replay-test:${randomUUID()}`;
    const eventBody = {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000, // → 300¢ > $1 hard-stop → fires both soft + hard
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
      idempotencyKey,
    } as any;

    // First insert → evaluator fires, opens incidents, writes activity log.
    const first = await costs.createEvent(companyId, eventBody);
    expect(first.costCents).toBe(300);
    expect((first as any).inserted).toBeUndefined(); // synthetic column stripped

    const incidentsAfterFirst = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.policyId, policyId));
    expect(incidentsAfterFirst.length).toBeGreaterThanOrEqual(1);

    const activityAfterFirst = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    const thresholdRowsAfterFirst = activityAfterFirst.filter(
      (r) =>
        r.action === "budget.soft_threshold_crossed" ||
        r.action === "budget.hard_threshold_crossed",
    );
    expect(thresholdRowsAfterFirst.length).toBe(2); // one soft + one hard

    // Replay: same idempotency_key, same body → ON CONFLICT DO UPDATE on the
    // same row. Q18 gate must skip budget evaluation entirely.
    const second = await costs.createEvent(companyId, eventBody);
    expect(second.id).toBe(first.id); // same row, not a duplicate insert

    const incidentsAfterSecond = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.policyId, policyId));
    // Same count (createIncidentIfNeeded would have deduped even without the
    // gate, but we still want to be sure).
    expect(incidentsAfterSecond.length).toBe(incidentsAfterFirst.length);

    const activityAfterSecond = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    const thresholdRowsAfterSecond = activityAfterSecond.filter(
      (r) =>
        r.action === "budget.soft_threshold_crossed" ||
        r.action === "budget.hard_threshold_crossed",
    );
    // The critical assertion: replay did NOT add another activity log row.
    // Without the Q18 gate this would be 4 (2 from each evaluator call).
    expect(thresholdRowsAfterSecond.length).toBe(2);
  });

  it("server-side classifier leaves unknown for hybrid providers without env signal", async () => {
    // claude-bridge and openai-codex are hybrid (subscription OR metered
    // depending on env). Server can't see env; emitter must set explicitly.
    // If no emitter set it, leave it `unknown` so it shows up in the dashboard
    // gap report rather than silently misclassifying.
    const event = await costs.createEvent(companyId, {
      agentId,
      provider: "claude-bridge",
      biller: "claude-bridge",
      // billingType omitted, provider is hybrid
      model: "claude-sonnet-4-6",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
      idempotencyKey: `classifier-hybrid-1`,
    } as any);
    expect(event.billingType).toBe("unknown");
  });
});
