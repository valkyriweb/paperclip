import postgres from "postgres";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { computeCostCents, pricingProviderFor, normalizeModelForPricing } from "@paperclipai/shared";

import { costEvents } from "./schema/cost_events.js";
import { modelPricing } from "./schema/model_pricing.js";

/**
 * One-shot backfill: walks every cost_events row where costCents = 0 and
 * billing_type is metered, looks up the latest model_pricing row whose
 * effective_at <= cost_events.occurred_at for the (aliased provider, model),
 * and re-prices the row.
 *
 * Subscription rows are left at 0 by design (they have no per-token cost).
 *
 * Idempotent: re-running is safe — the WHERE clause excludes already-priced
 * rows. Pass `--dry-run` (or `{ dryRun: true }`) to see counts without
 * writing.
 *
 * Required env: DATABASE_URL.
 *
 * Substream: see agent-system/PAPERCLIP-BUDGET-INTEGRATION.md P2.5.
 */

const METERED_BILLING_TYPES = ["metered_api", "subscription_overage", "credits"] as const;

export type BackfillSummary = {
  scanned: number;
  priced: number;
  unmatched: number;
  totalCentsApplied: number;
  dryRun: boolean;
};

export async function backfillCostCents(
  options: {
    connectionString?: string;
    dryRun?: boolean;
    batchSize?: number;
  } = {},
): Promise<BackfillSummary> {
  const url = options.connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required (or pass connectionString)");
  }
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? 500;

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  let scanned = 0;
  let priced = 0;
  let unmatched = 0;
  let totalCentsApplied = 0;

  try {
    // Stream candidate rows in id-sorted batches so reruns continue from
    // where they left off and a transient failure doesn't lose work.
    let lastId: string | null = null;
    while (true) {
      const conditions = [
        eq(costEvents.costCents, 0),
        // Only re-price metered rows. Subscription stays at 0.
        // Use raw IN to keep the query plan readable.
        sql`${costEvents.billingType} = ANY(${sql.raw(`ARRAY[${METERED_BILLING_TYPES.map((value) => `'${value}'`).join(",")}]::text[]`)})`,
        // Only rows that actually have token usage to price.
        sql`(${costEvents.inputTokens} + ${costEvents.cachedInputTokens} + ${costEvents.cacheCreationInputTokens} + ${costEvents.outputTokens}) > 0`,
      ];
      if (lastId !== null) {
        conditions.push(sql`${costEvents.id} > ${lastId}`);
      }

      const batch = await db
        .select({
          id: costEvents.id,
          provider: costEvents.provider,
          model: costEvents.model,
          occurredAt: costEvents.occurredAt,
          inputTokens: costEvents.inputTokens,
          cachedInputTokens: costEvents.cachedInputTokens,
          cacheCreationInputTokens: costEvents.cacheCreationInputTokens,
          outputTokens: costEvents.outputTokens,
        })
        .from(costEvents)
        .where(and(...conditions))
        .orderBy(costEvents.id)
        .limit(batchSize);

      if (batch.length === 0) break;
      scanned += batch.length;
      lastId = batch[batch.length - 1].id;

      for (const row of batch) {
        const lookupProvider = pricingProviderFor(row.provider);
        const [pricing] = await db
          .select({
            inputCpmMicros: modelPricing.inputCpmMicros,
            cachedInputCpmMicros: modelPricing.cachedInputCpmMicros,
            cacheWriteCpmMicros: modelPricing.cacheWriteCpmMicros,
            outputCpmMicros: modelPricing.outputCpmMicros,
          })
          .from(modelPricing)
          .where(
            and(
              eq(modelPricing.provider, lookupProvider),
              // Mirror the live path (server/services/costs.ts): normalize both
              // sides so dot-form and dash-form model names match.
              sql`replace(${modelPricing.model}, '.', '-') = ${normalizeModelForPricing(row.model)}`,
              lte(modelPricing.effectiveAt, row.occurredAt),
            ),
          )
          .orderBy(sql`${modelPricing.effectiveAt} DESC`)
          .limit(1);

        if (!pricing) {
          unmatched += 1;
          continue;
        }

        // Shared with server/src/services/costs.ts to avoid silent drift.
        // Both call sites must produce the same cents for the same row.
        const cents = computeCostCents(
          {
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            cacheCreationInputTokens: row.cacheCreationInputTokens,
            outputTokens: row.outputTokens,
          },
          pricing,
        );
        if (cents === 0) {
          // Token rates were 0 for this model — counts as priced (the answer is
          // legitimately zero), don't keep retrying it on the next run.
          priced += 1;
          continue;
        }

        if (!dryRun) {
          // Only update rows that are still at 0 — guards against a parallel
          // writer landing a non-zero costCents between our select and update.
          const updated = await db
            .update(costEvents)
            .set({ costCents: cents })
            .where(and(eq(costEvents.id, row.id), eq(costEvents.costCents, 0)))
            .returning({ id: costEvents.id });
          if (updated.length > 0) {
            priced += 1;
            totalCentsApplied += cents;
          }
        } else {
          priced += 1;
          totalCentsApplied += cents;
        }
      }
    }
  } finally {
    await client.end();
  }

  return { scanned, priced, unmatched, totalCentsApplied, dryRun };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const summary = await backfillCostCents({ dryRun });
  const verb = dryRun ? "would price" : "priced";
  console.log(
    `backfill-cost-cents: scanned ${summary.scanned}, ${verb} ${summary.priced}, ` +
      `unmatched ${summary.unmatched}, total cents applied $${(summary.totalCentsApplied / 100).toFixed(2)}` +
      (dryRun ? " (dry-run)" : ""),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
