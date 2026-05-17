/**
 * Integration tests for verify-budget-rollout's SQL gates.
 *
 * Spins up an embedded postgres, applies real schema, seeds known data per
 * gate, asserts pass/fail. Catches SQL typos and column-name drift before
 * Luke discovers them at deploy time.
 *
 * Substream: agent-system/PAPERCLIP-BUDGET-INTEGRATION.md.
 */

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  sql,
  createDb,
  companies,
  agents,
  projects,
  issues,
  costEvents,
  budgetPolicies,
  heartbeatRuns,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "../packages/db/src/index.js";
import {
  gateG1,
  gateG2,
  gateG2b,
  gateG3,
  gateG4,
  gateG5,
  gateG6,
  type Args,
} from "./verify-budget-rollout.js";

let tempDb: EmbeddedPostgresTestDatabase;
let db: ReturnType<typeof createDb>;
let companyId: string;
let agentId: string;
let projectId: string;

const baseArgs: Args = {
  companyId: null,
  all: true,
  windowHours: 24,
  expectedBillers: ["anthropic", "openai", "claude-bridge", "multica"],
  unknownThreshold: 0,
  databaseUrl: "",
};

before(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("verify-budget-");
  db = createDb(tempDb.connectionString);
});

after(async () => {
  await tempDb?.cleanup();
});

beforeEach(async () => {
  // Order matters under FK constraints.
  await db.delete(costEvents);
  await db.delete(heartbeatRuns);
  await db.delete(budgetPolicies);
  await db.delete(issues);
  await db.delete(projects);
  await db.delete(agents);
  await db.delete(companies);

  companyId = randomUUID();
  agentId = randomUUID();
  projectId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "VerifierTest",
    issuePrefix: `V${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "test-agent",
    role: "engineer",
    status: "active",
    adapterType: "pi_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "test-project",
    status: "active",
  });
});

function makeCostEvent(overrides: Partial<typeof costEvents.$inferInsert> = {}) {
  return {
    companyId,
    agentId,
    provider: "anthropic",
    biller: "anthropic",
    billingType: "metered_api",
    model: "claude-sonnet-4-6",
    inputTokens: 1000,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 100,
    costCents: 5,
    occurredAt: new Date(),
    ...overrides,
  } as typeof costEvents.$inferInsert;
}

describe("verify-budget-rollout gates", () => {
  describe("G1 — every expected biller present", () => {
    it("fails when no rows exist", async () => {
      const r = await gateG1(db, baseArgs, [companyId]);
      assert.equal(r.passed, false);
      assert.ok(r.detail.includes("missing billers"));
    });

    it("passes when every expected biller has at least one row in window", async () => {
      for (const biller of baseArgs.expectedBillers) {
        await db.insert(costEvents).values(makeCostEvent({
          biller,
          provider: biller === "multica" ? "anthropic" : biller,
          billingCode: `${biller}:1`,
        }));
      }
      const r = await gateG1(db, baseArgs, [companyId]);
      assert.equal(r.passed, true);
    });

    it("fails when one expected biller is missing", async () => {
      await db.insert(costEvents).values(makeCostEvent({ biller: "anthropic", billingCode: "a:1" }));
      await db.insert(costEvents).values(makeCostEvent({ biller: "openai", billingCode: "o:1" }));
      // claude-bridge and multica missing
      const r = await gateG1(db, baseArgs, [companyId]);
      assert.equal(r.passed, false);
      assert.ok(r.detail.includes("claude-bridge"));
      assert.ok(r.detail.includes("multica"));
    });

    it("ignores rows outside the window", async () => {
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago
      for (const biller of baseArgs.expectedBillers) {
        await db.insert(costEvents).values(makeCostEvent({
          biller,
          occurredAt: old,
          billingCode: `${biller}-old`,
        }));
      }
      const r = await gateG1(db, baseArgs, [companyId]);
      assert.equal(r.passed, false); // window=24h, all rows are 48h old
    });
  });

  describe("G2 — no unknown rows for non-hybrid billers", () => {
    it("passes when threshold is met", async () => {
      await db.insert(costEvents).values(makeCostEvent({ biller: "anthropic", billingType: "metered_api" }));
      const r = await gateG2(db, baseArgs, [companyId]);
      assert.equal(r.passed, true);
    });

    it("fails when anthropic has unknown rows", async () => {
      await db.insert(costEvents).values(makeCostEvent({ biller: "anthropic", billingType: "unknown" }));
      const r = await gateG2(db, baseArgs, [companyId]);
      assert.equal(r.passed, false);
      assert.ok(r.detail.includes("anthropic"));
    });

    it("excludes hybrid claude-bridge from the check", async () => {
      // claude-bridge legitimately stays unknown without env signal
      await db.insert(costEvents).values(makeCostEvent({ biller: "claude-bridge", billingType: "unknown" }));
      const r = await gateG2(db, baseArgs, [companyId]);
      assert.equal(r.passed, true);
    });
  });

  describe("G2b — billing_type matches expected per biller", () => {
    it("passes when classification is consistent", async () => {
      await db.insert(costEvents).values(makeCostEvent({ biller: "anthropic", billingType: "metered_api" }));
      const r = await gateG2b(db, baseArgs, [companyId]);
      assert.equal(r.passed, true);
    });

    it("fails when anthropic is mis-classified as subscription_included", async () => {
      await db.insert(costEvents).values(makeCostEvent({
        biller: "anthropic",
        billingType: "subscription_included",
        billingCode: "wrong-classification",
      }));
      const r = await gateG2b(db, baseArgs, [companyId]);
      assert.equal(r.passed, false);
    });
  });

  describe("G5 — no metered rows with cost=0 and tokens>0", () => {
    it("passes when every metered row has a non-zero cost", async () => {
      await db.insert(costEvents).values(makeCostEvent({
        billingType: "metered_api",
        costCents: 5,
        inputTokens: 1000,
        outputTokens: 100,
      }));
      const r = await gateG5(db, baseArgs, [companyId]);
      assert.equal(r.passed, true);
    });

    it("ignores subscription_included rows (legitimately zero)", async () => {
      await db.insert(costEvents).values(makeCostEvent({
        biller: "claude-code",
        billingType: "subscription_included",
        costCents: 0,
        inputTokens: 1000,
        outputTokens: 100,
      }));
      const r = await gateG5(db, baseArgs, [companyId]);
      assert.equal(r.passed, true);
    });

    it("ignores zero-token metered rows (legitimately zero — handshake/metadata)", async () => {
      await db.insert(costEvents).values(makeCostEvent({
        billingType: "metered_api",
        costCents: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
      }));
      const r = await gateG5(db, baseArgs, [companyId]);
      assert.equal(r.passed, true);
    });

    it("fails when a metered row has tokens but no resolved price", async () => {
      await db.insert(costEvents).values(makeCostEvent({
        biller: "anthropic",
        model: "claude-future-unreleased",
        billingType: "metered_api",
        costCents: 0,
        inputTokens: 1000,
        outputTokens: 100,
        billingCode: "missing-pricing-1",
      }));
      const r = await gateG5(db, baseArgs, [companyId]);
      assert.equal(r.passed, false);
      assert.ok(r.detail.includes("claude-future-unreleased"));
      assert.ok(r.detail.includes("add a model_pricing row"));
    });
  });

  describe("G6 — no duplicate billing_codes", () => {
    it("passes when no duplicates exist", async () => {
      await db.insert(costEvents).values(makeCostEvent({ billingCode: "unique-1" }));
      await db.insert(costEvents).values(makeCostEvent({ billingCode: "unique-2" }));
      const r = await gateG6(db, baseArgs, [companyId]);
      assert.equal(r.passed, true);
    });

    // Note: the partial unique index makes inserting duplicates impossible at
    // the DB level, so we can't directly test the fail path without bypassing
    // the index. The passing test still proves the query syntax is correct.
  });

  describe("G3 — agent + project policies exist", () => {
    it("reports no policies when none exist", async () => {
      const r = await gateG3(db, baseArgs, [companyId]);
      assert.equal(r.passed, false);
      assert.ok(r.detail.includes("no active budget policies"));
    });

    it("passes (partial) with only agent policies", async () => {
      await db.insert(budgetPolicies).values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 10000,
        isActive: true,
      });
      const r = await gateG3(db, baseArgs, [companyId]);
      assert.equal(r.passed, true);
      assert.ok(r.detail.includes("agent"));
    });

    it("passes (full) with both agent and project policies", async () => {
      await db.insert(budgetPolicies).values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 10000,
        isActive: true,
      });
      await db.insert(budgetPolicies).values({
        companyId,
        scopeType: "project",
        scopeId: projectId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 50000,
        isActive: true,
      });
      const r = await gateG3(db, baseArgs, [companyId]);
      assert.equal(r.passed, true);
      assert.ok(r.detail.includes("agent"));
      assert.ok(r.detail.includes("project"));
    });
  });

  describe("G4 — paused-by-budget scopes have not started new runs", () => {
    it("passes when no agents are paused", async () => {
      const r = await gateG4(db, baseArgs, [companyId]);
      assert.equal(r.passed, true);
    });

    it("fails when paused agent has a newer heartbeat run (uses paused_at not updated_at)", async () => {
      const pausedAt = new Date(Date.now() - 60_000); // 1 minute ago
      await db
        .update(agents)
        .set({ status: "paused", pauseReason: "budget", pausedAt })
        .where(sql`id = ${agentId}::uuid`);

      // Run that started AFTER the pause — a leak
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        startedAt: new Date(), // now > pausedAt
      });

      const r = await gateG4(db, baseArgs, [companyId]);
      assert.equal(r.passed, false);
      assert.ok(r.detail.includes("agent"));
    });

    it("passes when paused agent's runs all started BEFORE pause", async () => {
      const pausedAt = new Date();
      const oldRunStart = new Date(Date.now() - 60_000);
      await db
        .update(agents)
        .set({ status: "paused", pauseReason: "budget", pausedAt })
        .where(sql`id = ${agentId}::uuid`);
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        startedAt: oldRunStart,
      });
      const r = await gateG4(db, baseArgs, [companyId]);
      assert.equal(r.passed, true);
    });

    it("does not fire on agent pause for non-budget reason", async () => {
      const pausedAt = new Date(Date.now() - 60_000);
      await db
        .update(agents)
        .set({ status: "paused", pauseReason: "manual", pausedAt })
        .where(sql`id = ${agentId}::uuid`);
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        startedAt: new Date(),
      });
      const r = await gateG4(db, baseArgs, [companyId]);
      assert.equal(r.passed, true); // pause_reason != 'budget'
    });

    it("project-level leak: run on agent-without-pause but issue-in-paused-project", async () => {
      const pausedAt = new Date(Date.now() - 60_000);
      await db
        .update(projects)
        .set({ status: "paused", pauseReason: "budget", pausedAt })
        .where(sql`id = ${projectId}::uuid`);

      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        projectId,
        identifier: 1,
        title: "test",
        externalId: "TEST-1",
        status: "open",
        priority: "medium",
      });

      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        startedAt: new Date(),
        contextSnapshot: { issueId },
      });

      const r = await gateG4(db, baseArgs, [companyId]);
      assert.equal(r.passed, false);
      assert.ok(r.detail.includes("project"));
    });
  });
});
