import postgres from "postgres";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";

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

/**
 * Keep this aliased in sync with the same table in `server/src/services/costs.ts`.
 * Both should ideally read from one canonical map; for now this is a one-shot
 * script with no live coupling, so we duplicate-and-comment.
 */
const PRICING_PROVIDER_ALIASES: Record<string, string> = {
  "claude-bridge": "anthropic",
};

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
        const lookupProvider = PRICING_PROVIDER_ALIASES[row.provider] ?? row.provider;
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
              eq(modelPricing.model, row.model),
              lte(modelPricing.effectiveAt, row.occurredAt),
            ),
          )
          .orderBy(sql`${modelPricing.effectiveAt} DESC`)
          .limit(1);

        if (!pricing) {
          unmatched += 1;
          continue;
        }

        // Same math as server/src/services/costs.ts computeCostCents.
        // Divisor 1e12: 1e6 to collapse per-million-tokens, 1e6 to convert
        // micro-cents -> cents.
        const microCentTokenProduct =
          row.inputTokens * pricing.inputCpmMicros +
          row.cachedInputTokens * pricing.cachedInputCpmMicros +
          row.cacheCreationInputTokens * pricing.cacheWriteCpmMicros +
          row.outputTokens * pricing.outputCpmMicros;
        const cents = Math.max(0, Math.round(microCentTokenProduct / 1e12));
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
