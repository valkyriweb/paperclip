/**
 * Cost-event pricing math, hoisted to @paperclipai/shared so the server's
 * runtime computation (services/costs.ts) and the backfill script
 * (packages/db/src/backfill-cost-cents.ts) share one source of truth.
 *
 * Substream: agent-system/PAPERCLIP-BUDGET-INTEGRATION.md G5 follow-up.
 *
 * The two callers can't import from each other (different workspace
 * packages; @paperclipai/db must not depend on @paperclipai/server). Before
 * this hoist they each had their own copy of the same 4-term sum, with
 * nothing locking them in sync \u2014 a future contributor changing one and
 * forgetting the other would silently desynchronize live vs. backfilled
 * prices, producing two different cents totals for the same row depending
 * on which path priced it.
 */

/**
 * Token counts on a cost event, broken out by Anthropic-style cache role:
 *   - input: fresh prompt tokens billed at the full input rate
 *   - cachedInput: cache-read tokens (already-cached prefix being re-served)
 *   - cacheCreationInput: cache-write tokens (prefix being newly cached)
 *   - output: model-generated tokens
 *
 * For non-Anthropic providers, cachedInput and cacheCreationInput should be 0.
 * Their pricing entries may have zero rates for those fields too \u2014 either way
 * the math collapses to the standard input+output formula.
 */
export interface CostEventTokens {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
}

/**
 * Per-million-token rates expressed in micro-cents. Storing in micro-cents
 * (rather than cents or dollars) keeps the math in integer space until the
 * final division and avoids floating-point drift on small token counts.
 *
 *   $3 / Mtok  \u2192  3_000_000 micro-cents / 1_000_000 tokens  \u2192  inputCpmMicros = 300_000_000
 *
 * The divisor 1e12 in {@link computeCostCents} is 1e6 (per-million-tokens)
 * \u00d7 1e6 (micro-cents \u2192 cents).
 */
export interface ModelPricingRates {
  inputCpmMicros: number;
  cachedInputCpmMicros: number;
  cacheWriteCpmMicros: number;
  outputCpmMicros: number;
}

/**
 * Compute integer cost in cents from token counts and per-million rates.
 *
 * Always non-negative; never returns NaN. Math.round at the end means
 * sub-cent fractions are banker-rounded to the nearest cent.
 */
export function computeCostCents(tokens: CostEventTokens, pricing: ModelPricingRates): number {
  const microCentTokenProduct =
    tokens.inputTokens * pricing.inputCpmMicros +
    tokens.cachedInputTokens * pricing.cachedInputCpmMicros +
    tokens.cacheCreationInputTokens * pricing.cacheWriteCpmMicros +
    tokens.outputTokens * pricing.outputCpmMicros;
  return Math.max(0, Math.round(microCentTokenProduct / 1e12));
}
