import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { seedModelPricing, usdPerTokenToCpmMicros } from "./seed-model-pricing.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-seed-pricing-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

describe("usdPerTokenToCpmMicros", () => {
  it("converts dollars per token to micro-cents per million tokens", () => {
    // $3 / 1M tokens → $3e-6 per token → 3e-6 * 1e14 = 300_000_000 CPM micros
    expect(usdPerTokenToCpmMicros("0.000003")).toBe(300_000_000);
    // $15 / 1M tokens → $1.5e-5 per token → 1.5e-5 * 1e14 = 1_500_000_000 CPM micros
    expect(usdPerTokenToCpmMicros("0.000015")).toBe(1_500_000_000);
    // $0.30 / 1M tokens (Sonnet cache read) → 3e-7 * 1e14 = 30_000_000 CPM micros
    expect(usdPerTokenToCpmMicros("0.0000003")).toBe(30_000_000);
  });

  it("returns 0 for null/empty/invalid input", () => {
    expect(usdPerTokenToCpmMicros(null)).toBe(0);
    expect(usdPerTokenToCpmMicros(undefined)).toBe(0);
    expect(usdPerTokenToCpmMicros("")).toBe(0);
    expect(usdPerTokenToCpmMicros("not-a-number")).toBe(0);
    expect(usdPerTokenToCpmMicros("-0.000003")).toBe(0);
  });
});

describe("seedModelPricing alias-keyed provider guard", () => {
  it("rejects a seed row whose provider is a pricing alias", async () => {
    // 'claude-bridge' aliases to 'anthropic' — seeding under it would create a
    // row no lookup ever reaches. The guard must reject it before any DB work.
    await expect(
      seedModelPricing({
        rows: [
          {
            provider: "claude-bridge",
            model: "claude-sonnet-4-6",
            input_per_token_usd: "0.000003",
            output_per_token_usd: "0.000015",
            cache_read_per_token_usd: null,
            cache_write_per_token_usd: null,
            source: "test",
          },
        ],
      }),
    ).rejects.toThrow(/claude-bridge.*anthropic/);
  });
});

describeEmbeddedPostgres("seedModelPricing", () => {
  it(
    "inserts each row exactly once and is idempotent on re-run",
    async () => {
      const connectionString = await createTempDatabase();
      await applyPendingMigrations(connectionString);

      // Use a tiny inline fixture rather than the bundled 180-row file so the
      // test runs fast and stays decoupled from snapshot churn.
      const rows = [
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          input_per_token_usd: "0.000003",
          output_per_token_usd: "0.000015",
          cache_read_per_token_usd: "0.0000003",
          cache_write_per_token_usd: "0.00000375",
          source: "vercel-ai-gateway",
        },
        {
          provider: "openai",
          model: "gpt-5-codex",
          input_per_token_usd: "0.00000125",
          output_per_token_usd: "0.00001",
          cache_read_per_token_usd: null,
          cache_write_per_token_usd: null,
          source: "vercel-ai-gateway",
        },
      ];

      const first = await seedModelPricing({
        connectionString,
        effectiveAt: "2026-05-17T00:00:00.000Z",
        rows,
      });
      expect(first).toEqual({
        total: 2,
        inserted: 2,
        skipped: 0,
        effectiveAt: "2026-05-17T00:00:00.000Z",
      });

      // Re-run: composite PK (provider, model, effective_at) collides on every row.
      const second = await seedModelPricing({
        connectionString,
        effectiveAt: "2026-05-17T00:00:00.000Z",
        rows,
      });
      expect(second.inserted).toBe(0);
      expect(second.skipped).toBe(2);

      // Verify row shape and CPM-micros conversion landed correctly.
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const stored = await sql.unsafe<
          {
            provider: string;
            model: string;
            input_cpm_micros: string;
            cached_input_cpm_micros: string;
            cache_write_cpm_micros: string;
            output_cpm_micros: string;
            source: string;
          }[]
        >(
          `SELECT provider, model, input_cpm_micros, cached_input_cpm_micros,
                  cache_write_cpm_micros, output_cpm_micros, source
             FROM model_pricing
             ORDER BY provider, model`,
        );
        expect(stored).toHaveLength(2);
        expect(stored[0]).toEqual({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          input_cpm_micros: "300000000",
          cached_input_cpm_micros: "30000000",
          cache_write_cpm_micros: "375000000",
          output_cpm_micros: "1500000000",
          source: "vercel-ai-gateway",
        });
        expect(stored[1]).toEqual({
          provider: "openai",
          model: "gpt-5-codex",
          input_cpm_micros: "125000000",
          cached_input_cpm_micros: "0",
          cache_write_cpm_micros: "0",
          output_cpm_micros: "1000000000",
          source: "vercel-ai-gateway",
        });
      } finally {
        await sql.end();
      }

      // Same provider/model with a NEW effective_at produces a fresh row,
      // mirroring how a price change ships in production.
      const third = await seedModelPricing({
        connectionString,
        effectiveAt: "2026-06-01T00:00:00.000Z",
        rows: [
          {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            input_per_token_usd: "0.0000035",
            output_per_token_usd: "0.0000175",
            cache_read_per_token_usd: "0.00000035",
            cache_write_per_token_usd: "0.00000438",
            source: "vercel-ai-gateway",
          },
        ],
      });
      expect(third.inserted).toBe(1);

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const claudeRows = await verifySql.unsafe<{ effective_at: Date; input_cpm_micros: string }[]>(
          `SELECT effective_at, input_cpm_micros
             FROM model_pricing
             WHERE provider = 'anthropic' AND model = 'claude-sonnet-4-6'
             ORDER BY effective_at`,
        );
        expect(claudeRows).toHaveLength(2);
        expect(claudeRows[1].input_cpm_micros).toBe("350000000");
      } finally {
        await verifySql.end();
      }
    },
    30_000,
  );

  it(
    "loads the bundled Vercel snapshot end-to-end",
    async () => {
      const connectionString = await createTempDatabase();
      await applyPendingMigrations(connectionString);

      const summary = await seedModelPricing({ connectionString });
      // The bundled snapshot has 180 language-model rows at time of writing;
      // assert a stable lower bound so the test does not break every refresh.
      expect(summary.total).toBeGreaterThanOrEqual(150);
      expect(summary.inserted).toBe(summary.total);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        // Smilerite-critical models must be present after seeding from the
        // bundled snapshot — this is the operational contract.
        const smilerite = await sql.unsafe<{ provider: string; model: string; input_cpm_micros: string }[]>(
          `SELECT provider, model, input_cpm_micros
             FROM model_pricing
             WHERE (provider, model) IN (
               ('anthropic','claude-sonnet-4-6'),
               ('anthropic','claude-opus-4-7'),
               ('anthropic','claude-haiku-4-5'),
               ('openai','gpt-5-codex')
             )
             ORDER BY provider, model`,
        );
        expect(smilerite.map((row) => `${row.provider}/${row.model}`)).toEqual([
          "anthropic/claude-haiku-4-5",
          "anthropic/claude-opus-4-7",
          "anthropic/claude-sonnet-4-6",
          "openai/gpt-5-codex",
        ]);
        // input_cpm_micros must be a positive integer for each — guard against
        // a snapshot regression that drops these rows back to free.
        for (const row of smilerite) {
          expect(Number(row.input_cpm_micros)).toBeGreaterThan(0);
        }
      } finally {
        await sql.end();
      }
    },
    30_000,
  );
});
