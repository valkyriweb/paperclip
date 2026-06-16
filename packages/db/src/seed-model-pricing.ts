import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { PRICING_PROVIDER_ALIASES } from "@paperclipai/shared";

import { modelPricing } from "./schema/model_pricing.js";

/**
 * Default effective-at applied to every row inserted by this seed run.
 * Pinned to the snapshot date so re-running the same seed produces the same
 * (provider, model, effective_at) composite key — i.e. idempotent.
 *
 * Override with PAPERCLIP_MODEL_PRICING_EFFECTIVE_AT (ISO-8601) when seeding
 * a fresh price snapshot.
 */
const DEFAULT_EFFECTIVE_AT = "2026-05-17T00:00:00.000Z";

/**
 * Bundled seed-data file. Copy of the Vercel AI Gateway snapshot kept in the
 * umbrella planning repo. See `seed-data/README.md` for the refresh workflow.
 */
const SEED_DATA_PATH = fileURLToPath(new URL("./seed-data/model-pricing.json", import.meta.url));

type SeedRow = {
  provider: string;
  model: string;
  input_per_token_usd: string | null;
  output_per_token_usd: string | null;
  cache_read_per_token_usd: string | null;
  cache_write_per_token_usd: string | null;
  source: string;
};

type SeedFile = {
  schema_version: number;
  rows: SeedRow[];
};

/**
 * Convert USD per token (decimal string) to micro-cents per million tokens.
 *
 * Example: "0.000003" USD/token → 3e-6 USD/token × 1e14 = 300_000_000 CPM micros.
 * Sanity check: that's $3.00 per million tokens, the Anthropic Sonnet input rate.
 *
 * Returns 0 for null/empty/invalid input — model_pricing.* columns are
 * NOT NULL DEFAULT 0, and a missing rate is operationally indistinguishable
 * from a zero rate (subscription-only models have no input/output charge).
 */
export function usdPerTokenToCpmMicros(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  // 1e14 = 1e6 (per-million) × 1e8 (USD → micro-cents, i.e. 100c × 1e6 micro)
  return Math.round(parsed * 1e14);
}

export type SeedSummary = {
  total: number;
  inserted: number;
  skipped: number;
  effectiveAt: string;
};

export async function seedModelPricing(
  options: { effectiveAt?: string; rows?: SeedRow[]; connectionString?: string } = {},
): Promise<SeedSummary> {
  const effectiveAt = options.effectiveAt ?? process.env.PAPERCLIP_MODEL_PRICING_EFFECTIVE_AT ?? DEFAULT_EFFECTIVE_AT;
  if (Number.isNaN(Date.parse(effectiveAt))) {
    throw new Error(`Invalid effective-at: ${effectiveAt}`);
  }

  const rows =
    options.rows ??
    (JSON.parse(await readFile(SEED_DATA_PATH, "utf8")) as SeedFile).rows;

  // An alias-keyed provider (e.g. 'claude-bridge') would be inserted under a key
  // the live path and backfill never look up — they resolve it to its canonical
  // provider before querying — so the row would silently never price. Reject it
  // at seed time and make the author use the canonical provider.
  const aliased = rows.find((row) => row.provider in PRICING_PROVIDER_ALIASES);
  if (aliased) {
    const canonical = PRICING_PROVIDER_ALIASES[aliased.provider];
    throw new Error(
      `Seed row provider '${aliased.provider}' is a pricing alias for '${canonical}'. ` +
        `Seed under '${canonical}' instead — alias-keyed rows are unreachable by the ` +
        `live path and backfill, which resolve '${aliased.provider}' → '${canonical}' before lookup.`,
    );
  }

  if (rows.length === 0) {
    return { total: 0, inserted: 0, skipped: 0, effectiveAt };
  }

  const url = options.connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required (or pass connectionString to seedModelPricing)");
  }
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    const values = rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      effectiveAt: new Date(effectiveAt),
      inputCpmMicros: usdPerTokenToCpmMicros(row.input_per_token_usd),
      cachedInputCpmMicros: usdPerTokenToCpmMicros(row.cache_read_per_token_usd),
      cacheWriteCpmMicros: usdPerTokenToCpmMicros(row.cache_write_per_token_usd),
      outputCpmMicros: usdPerTokenToCpmMicros(row.output_per_token_usd),
      source: row.source,
    }));

    // ON CONFLICT DO NOTHING — model_pricing is append-only by composite PK
    // (provider, model, effective_at), so re-running the same seed against an
    // already-populated DB is a no-op. Price changes ship as new rows with a
    // newer effective_at via a follow-up seed run.
    const result = await db
      .insert(modelPricing)
      .values(values)
      .onConflictDoNothing()
      .returning({ provider: modelPricing.provider, model: modelPricing.model });

    return {
      total: rows.length,
      inserted: result.length,
      skipped: rows.length - result.length,
      effectiveAt,
    };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const summary = await seedModelPricing();
  console.log(
    `model_pricing seed: inserted ${summary.inserted}/${summary.total} ` +
      `(${summary.skipped} skipped on conflict) at effective_at=${summary.effectiveAt}`,
  );
}

// Auto-run when executed directly (tsx src/seed-model-pricing.ts), skip when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
