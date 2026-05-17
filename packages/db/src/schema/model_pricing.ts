import { pgTable, text, timestamp, bigint, index, primaryKey } from "drizzle-orm/pg-core";

/**
 * Per-model token pricing, source of truth for server-side cost computation.
 *
 * Seeded from Vercel AI Gateway's public model catalog (refreshed daily). Rows
 * are keyed by (provider, model, effectiveAt) so price changes are append-only
 * and historical cost_events can be re-priced deterministically.
 *
 * All four token rates are stored as micro-cents per million tokens (CPM
 * micros) — i.e. price_cents_per_million_tokens × 1_000_000 — to keep
 * arithmetic integer-safe end-to-end. Example: Anthropic claude-sonnet-4-6
 * input at $3.00 / MTok → 3_000_000 micro-cents-per-MTok.
 *
 * Lookup pattern: pick the row with the latest effectiveAt that is ≤ the
 * cost_event.occurredAt, matching (provider, model). When no row matches,
 * leave costCents = 0 and surface the gap in the dashboard so a human can
 * decide whether to add a manual pricing row.
 */
export const modelPricing = pgTable(
  "model_pricing",
  {
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    // CPM micros = micro-cents per million tokens (1e-6 cent precision).
    inputCpmMicros: bigint("input_cpm_micros", { mode: "number" }).notNull().default(0),
    cachedInputCpmMicros: bigint("cached_input_cpm_micros", { mode: "number" }).notNull().default(0),
    cacheWriteCpmMicros: bigint("cache_write_cpm_micros", { mode: "number" }).notNull().default(0),
    outputCpmMicros: bigint("output_cpm_micros", { mode: "number" }).notNull().default(0),
    // Where the row came from: "vercel-ai-gateway" | "manual" | "anthropic-docs" | …
    source: text("source").notNull().default("vercel-ai-gateway"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.provider, table.model, table.effectiveAt] }),
    lookupIdx: index("model_pricing_lookup_idx").on(table.provider, table.model, table.effectiveAt),
  }),
);
