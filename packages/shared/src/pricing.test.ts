/**
 * Tests for shared cost-event pricing math.
 *
 * Substream: agent-system/PAPERCLIP-BUDGET-INTEGRATION.md G5 follow-up.
 */

import { describe, expect, it } from "vitest";
import { computeCostCents, pricingProviderFor, normalizeModelForPricing } from "./pricing.js";

// Anthropic Sonnet 4.6 reference rates:
//   input $3/Mtok, cached $0.30/Mtok, cacheWrite $3.75/Mtok, output $15/Mtok.
const sonnet = {
  inputCpmMicros: 300_000_000,
  cachedInputCpmMicros: 30_000_000,
  cacheWriteCpmMicros: 375_000_000,
  outputCpmMicros: 1_500_000_000,
} as const;

const zeroTokens = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  outputTokens: 0,
} as const;

describe("computeCostCents", () => {
  it("returns 0 for an all-zero token usage", () => {
    expect(computeCostCents(zeroTokens, sonnet)).toBe(0);
  });

  it("prices fresh input at the input rate", () => {
    // 1M input @ $3/Mtok = 300 cents
    expect(computeCostCents({ ...zeroTokens, inputTokens: 1_000_000 }, sonnet)).toBe(300);
  });

  it("prices output at the output rate", () => {
    // 1M output @ $15/Mtok = 1500 cents
    expect(computeCostCents({ ...zeroTokens, outputTokens: 1_000_000 }, sonnet)).toBe(1500);
  });

  it("prices cache reads at the cached-input rate", () => {
    // 1M cached @ $0.30/Mtok = 30 cents
    expect(computeCostCents({ ...zeroTokens, cachedInputTokens: 1_000_000 }, sonnet)).toBe(30);
  });

  it("prices cache writes at the cache-write rate", () => {
    // 1M write @ $3.75/Mtok = 375 cents
    expect(computeCostCents({ ...zeroTokens, cacheCreationInputTokens: 1_000_000 }, sonnet)).toBe(375);
  });

  it("sums all four terms for a mixed workload", () => {
    // 1M of each: 300 + 30 + 375 + 1500 = 2205
    expect(
      computeCostCents(
        {
          inputTokens: 1_000_000,
          cachedInputTokens: 1_000_000,
          cacheCreationInputTokens: 1_000_000,
          outputTokens: 1_000_000,
        },
        sonnet,
      ),
    ).toBe(2205);
  });

  it("rounds sub-cent fractions to the nearest cent", () => {
    // 100_000 * 300_000_000 = 30_000_000_000_000  microcents
    //   = 30 cents exactly
    expect(computeCostCents({ ...zeroTokens, inputTokens: 100_000 }, sonnet)).toBe(30);

    // 1 input token @ $3/Mtok = 0.0003 cents \u2192 rounds to 0
    expect(computeCostCents({ ...zeroTokens, inputTokens: 1 }, sonnet)).toBe(0);

    // 1700 input tokens @ $3/Mtok = 0.51 cents \u2192 rounds to 1
    expect(computeCostCents({ ...zeroTokens, inputTokens: 1700 }, sonnet)).toBe(1);
  });

  it("returns 0 when all pricing rates are 0 (free model)", () => {
    expect(
      computeCostCents(
        {
          inputTokens: 1_000_000,
          cachedInputTokens: 1_000_000,
          cacheCreationInputTokens: 1_000_000,
          outputTokens: 1_000_000,
        },
        { inputCpmMicros: 0, cachedInputCpmMicros: 0, cacheWriteCpmMicros: 0, outputCpmMicros: 0 },
      ),
    ).toBe(0);
  });

  it("never returns negative", () => {
    // Pathological: negative rate (shouldn't happen via the seed, but the
    // contract is non-negative output).
    expect(
      computeCostCents(
        { ...zeroTokens, inputTokens: 1_000_000 },
        { ...sonnet, inputCpmMicros: -300_000_000 },
      ),
    ).toBe(0);
  });
});

describe("pricingProviderFor", () => {
  it("resolves a transport alias to its billing provider", () => {
    expect(pricingProviderFor("claude-bridge")).toBe("anthropic");
  });

  it("passes a provider with no alias through unchanged", () => {
    expect(pricingProviderFor("openai")).toBe("openai");
    expect(pricingProviderFor("anthropic")).toBe("anthropic");
  });
});

describe("normalizeModelForPricing", () => {
  it("collapses dots to dashes so dot/dash model names match", () => {
    expect(normalizeModelForPricing("gpt-5.5")).toBe("gpt-5-5");
    expect(normalizeModelForPricing("claude-3.5-haiku")).toBe("claude-3-5-haiku");
  });

  it("leaves an already-dashed name unchanged", () => {
    expect(normalizeModelForPricing("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });
});
