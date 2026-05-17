import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, createDb } from "./client.js";
import { backfillCostCents } from "./backfill-cost-cents.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";
import { agents, companies, costEvents, modelPricing } from "./schema/index.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-backfill-cost-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

describeEmbeddedPostgres("backfillCostCents", () => {
  let connectionString: string;
  let companyId: string;
  let agentId: string;

  beforeEach(async () => {
    connectionString = await createTempDatabase();
    await applyPendingMigrations(connectionString);

    const db = createDb(connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Backfill Test Co",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Backfill Agent",
      role: "engineer",
      status: "active",
      adapterType: "pi_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Anthropic Sonnet pricing: \$3/Mtok input, \$15/Mtok output,
    // \$0.30/Mtok cache read, \$3.75/Mtok cache write.
    await db.insert(modelPricing).values({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      effectiveAt: new Date("2026-05-01T00:00:00.000Z"),
      inputCpmMicros: 300_000_000,
      cachedInputCpmMicros: 30_000_000,
      cacheWriteCpmMicros: 375_000_000,
      outputCpmMicros: 1_500_000_000,
      source: "test",
    });
  });

  it(
    "prices zero-cost metered rows from model_pricing and leaves subscription rows alone",
    async () => {
      const db = createDb(connectionString);

      // 1. metered_api row at 0 cents but with tokens — must be priced.
      const meteredId = randomUUID();
      // 2. subscription_included row with tokens but 0 cents — must stay at 0.
      const subscriptionId = randomUUID();
      // 3. metered_api row with caller-supplied cost — must stay untouched.
      const alreadyPricedId = randomUUID();
      // 4. metered_api row with no pricing match — must stay at 0, counted unmatched.
      const unmatchedId = randomUUID();
      // 5. claude-bridge transport — must be aliased to anthropic for lookup.
      const bridgeId = randomUUID();

      await db.insert(costEvents).values([
        {
          id: meteredId,
          companyId,
          agentId,
          provider: "anthropic",
          biller: "anthropic",
          billingType: "metered_api",
          model: "claude-sonnet-4-6",
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          costCents: 0,
          occurredAt: new Date("2026-05-15T00:00:00.000Z"),
        },
        {
          id: subscriptionId,
          companyId,
          agentId,
          provider: "claude-bridge",
          biller: "claude-bridge",
          billingType: "subscription_included",
          model: "claude-sonnet-4-6",
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          costCents: 0,
          occurredAt: new Date("2026-05-15T00:00:00.000Z"),
        },
        {
          id: alreadyPricedId,
          companyId,
          agentId,
          provider: "anthropic",
          biller: "anthropic",
          billingType: "metered_api",
          model: "claude-sonnet-4-6",
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          costCents: 9999, // already priced — leave alone
          occurredAt: new Date("2026-05-15T00:00:00.000Z"),
        },
        {
          id: unmatchedId,
          companyId,
          agentId,
          provider: "some-new-provider",
          biller: "some-new-provider",
          billingType: "metered_api",
          model: "unknown-model",
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          costCents: 0,
          occurredAt: new Date("2026-05-15T00:00:00.000Z"),
        },
        {
          id: bridgeId,
          companyId,
          agentId,
          provider: "claude-bridge",
          biller: "claude-bridge",
          billingType: "metered_api",
          model: "claude-sonnet-4-6",
          inputTokens: 1_000_000,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          costCents: 0,
          occurredAt: new Date("2026-05-15T00:00:00.000Z"),
        },
      ]);

      const summary = await backfillCostCents({ connectionString });
      expect(summary.dryRun).toBe(false);
      // Scanned: metered (1M input + 100k output → 450c),
      //          unmatched (no pricing row → 0c skipped),
      //          bridge (1M input only → 300c).
      // Subscription and already-priced rows are filtered out by the WHERE clause.
      expect(summary.scanned).toBe(3);
      expect(summary.priced).toBe(2);
      expect(summary.unmatched).toBe(1);
      expect(summary.totalCentsApplied).toBe(750); // 450 + 300

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await sql.unsafe<{ id: string; cost_cents: number }[]>(
          `SELECT id, cost_cents FROM cost_events WHERE company_id = $1 ORDER BY id`,
          [companyId],
        );
        const byId = new Map(rows.map((row) => [row.id, row.cost_cents]));

        expect(byId.get(meteredId)).toBe(450); // 1M input * \$3 + 100k output * \$15 = 300 + 150
        expect(byId.get(subscriptionId)).toBe(0); // untouched
        expect(byId.get(alreadyPricedId)).toBe(9999); // untouched
        expect(byId.get(unmatchedId)).toBe(0); // no pricing match
        expect(byId.get(bridgeId)).toBe(300); // claude-bridge aliased to anthropic, 1M input only
      } finally {
        await sql.end();
      }
    },
    30_000,
  );

  it(
    "dry-run reports what would be priced without writing",
    async () => {
      const db = createDb(connectionString);
      const id = randomUUID();
      await db.insert(costEvents).values({
        id,
        companyId,
        agentId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        costCents: 0,
        occurredAt: new Date("2026-05-15T00:00:00.000Z"),
      });

      const summary = await backfillCostCents({ connectionString, dryRun: true });
      expect(summary).toEqual({
        scanned: 1,
        priced: 1,
        unmatched: 0,
        totalCentsApplied: 450,
        dryRun: true,
      });

      // Row remains at 0 cents because dry-run.
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const [row] = await sql.unsafe<{ cost_cents: number }[]>(
          `SELECT cost_cents FROM cost_events WHERE id = $1`,
          [id],
        );
        expect(row.cost_cents).toBe(0);
      } finally {
        await sql.end();
      }
    },
    20_000,
  );

  it(
    "idempotent: re-running after success skips already-priced rows",
    async () => {
      const db = createDb(connectionString);
      await db.insert(costEvents).values({
        companyId,
        agentId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        costCents: 0,
        occurredAt: new Date("2026-05-15T00:00:00.000Z"),
      });

      const first = await backfillCostCents({ connectionString });
      expect(first.priced).toBe(1);

      const second = await backfillCostCents({ connectionString });
      expect(second.scanned).toBe(0);
      expect(second.priced).toBe(0);
    },
    20_000,
  );

  it(
    "uses the latest model_pricing row whose effective_at <= occurredAt",
    async () => {
      const db = createDb(connectionString);
      // Newer price row: \$3.50/Mtok input.
      await db.insert(modelPricing).values({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effectiveAt: new Date("2026-05-10T00:00:00.000Z"),
        inputCpmMicros: 350_000_000,
        cachedInputCpmMicros: 35_000_000,
        cacheWriteCpmMicros: 437_500_000,
        outputCpmMicros: 1_750_000_000,
        source: "test",
      });

      const oldRowId = randomUUID();
      const newRowId = randomUUID();
      await db.insert(costEvents).values([
        {
          id: oldRowId,
          companyId,
          agentId,
          provider: "anthropic",
          biller: "anthropic",
          billingType: "metered_api",
          model: "claude-sonnet-4-6",
          inputTokens: 1_000_000,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          costCents: 0,
          // Before the newer price row's effective_at — uses the older \$3 rate.
          occurredAt: new Date("2026-05-05T00:00:00.000Z"),
        },
        {
          id: newRowId,
          companyId,
          agentId,
          provider: "anthropic",
          biller: "anthropic",
          billingType: "metered_api",
          model: "claude-sonnet-4-6",
          inputTokens: 1_000_000,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          costCents: 0,
          // After the newer price row — uses the \$3.50 rate.
          occurredAt: new Date("2026-05-20T00:00:00.000Z"),
        },
      ]);

      await backfillCostCents({ connectionString });

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await sql.unsafe<{ id: string; cost_cents: number }[]>(
          `SELECT id, cost_cents FROM cost_events WHERE id IN ($1, $2) ORDER BY id`,
          [oldRowId, newRowId],
        );
        const byId = new Map(rows.map((row) => [row.id, row.cost_cents]));
        expect(byId.get(oldRowId)).toBe(300); // \$3 rate
        expect(byId.get(newRowId)).toBe(350); // \$3.50 rate
      } finally {
        await sql.end();
      }
    },
    20_000,
  );

  it(
    "prices cache_read + cache_write tokens with the right per-Mtok rates",
    async () => {
      // Every other test in this file leaves cachedInputTokens and
      // cacheCreationInputTokens at 0 — the cache branches in the math are
      // untested. Anthropic prompt-caching workloads are typically 30-50%
      // cache reads + writes by token count, so a future refactor that
      // dropped or swapped those multiplications would silently underprice
      // every cached workload. This test locks the 4-term sum.
      //
      // Substream: agent-system/PAPERCLIP-BUDGET-INTEGRATION.md G5 follow-up.
      const db = createDb(connectionString);
      const id = randomUUID();
      await db.insert(costEvents).values({
        id,
        companyId,
        agentId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "claude-sonnet-4-6",
        // Pricing rates from beforeEach:
        //   input $3/Mtok, cached $0.30/Mtok, cacheWrite $3.75/Mtok, output $15/Mtok.
        // 1M of each → 300 + 30 + 375 + 1500 = 2205 cents.
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        outputTokens: 1_000_000,
        costCents: 0,
        occurredAt: new Date("2026-05-15T00:00:00.000Z"),
      });

      const summary = await backfillCostCents({ connectionString });
      expect(summary.priced).toBe(1);
      expect(summary.totalCentsApplied).toBe(2205);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const [row] = await sql.unsafe<{ cost_cents: number }[]>(
          `SELECT cost_cents FROM cost_events WHERE id = $1`,
          [id],
        );
        expect(row.cost_cents).toBe(2205);
      } finally {
        await sql.end();
      }
    },
    20_000,
  );

  it(
    "prices a cache-heavy workload where reads dominate (typical Anthropic shape)",
    async () => {
      // Realistic shape: a long-running session sends ~10x more cache reads
      // than fresh input. If the multiplier for cachedInputTokens were
      // swapped with inputTokens', total would be wildly off; locked here.
      const db = createDb(connectionString);
      const id = randomUUID();
      await db.insert(costEvents).values({
        id,
        companyId,
        agentId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "claude-sonnet-4-6",
        // 100k fresh input @ $3/Mtok               = 30 cents (rounded from 30.0)
        // 1M cached @ $0.30/Mtok                   = 30 cents
        // 50k cache write @ $3.75/Mtok             = 18.75 → 19 cents
        // 20k output @ $15/Mtok                    = 30 cents
        // = 109 cents (Math.round of 109.187... → microcent-precision yields 109)
        inputTokens: 100_000,
        cachedInputTokens: 1_000_000,
        cacheCreationInputTokens: 50_000,
        outputTokens: 20_000,
        costCents: 0,
        occurredAt: new Date("2026-05-15T00:00:00.000Z"),
      });

      const summary = await backfillCostCents({ connectionString });
      expect(summary.priced).toBe(1);
      // Exact computation:
      //   100_000 * 300_000_000     = 30_000_000_000_000
      //   1_000_000 * 30_000_000    = 30_000_000_000_000
      //   50_000 * 375_000_000      = 18_750_000_000_000
      //   20_000 * 1_500_000_000    = 30_000_000_000_000
      //   sum                       = 108_750_000_000_000
      //   sum / 1e12                = 108.75 → Math.round → 109
      expect(summary.totalCentsApplied).toBe(109);
    },
    20_000,
  );
});
