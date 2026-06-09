# Seed data

Static reference data bundled with `@paperclipai/db` for use by seed scripts.

## `model-pricing.json`

Per-model token pricing snapshot, normalised from the Vercel AI Gateway
catalog (`https://ai-gateway.vercel.sh/v1/models`). Source builder lives in
the umbrella planning repo at
`personal/agent-system/scripts/build-pricing-seed.py`, and the upstream
snapshot is at `personal/agent-system/reference/vercel-ai-gateway/`.

**Shape per row:**

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "input_per_token_usd": "0.000003",
  "output_per_token_usd": "0.000015",
  "cache_read_per_token_usd": "0.0000003",
  "cache_write_per_token_usd": "0.00000375",
  "source": "vercel-ai-gateway",
  ...
}
```

The pricing units in the JSON are **USD per token** (decimal strings to dodge
float drift). The seed script in `seed-model-pricing.ts` converts these to
`micro-cents-per-million-tokens` (CPM micros) integers — the storage format
of the `model_pricing` table.

Conversion: `cpm_micros = round(usd_per_token * 1e14)`. Sanity check —
$3.00 per million tokens (Anthropic Sonnet input) is
$3e-6 per token = round(3e-6 * 1e14) = 300_000_000 cpm_micros.

## Refresh workflow

1. `cd ~/Projects/personal/agent-system && python scripts/build-pricing-seed.py`
   — regenerates `reference/vercel-ai-gateway/pricing-seed.json` from the
   latest live Vercel catalog.
2. `cp ~/Projects/personal/agent-system/reference/vercel-ai-gateway/pricing-seed.json
       packages/db/src/seed-data/model-pricing.json` — copy to this package.
3. `pnpm --filter @paperclipai/db seed:pricing` — idempotent insert; new
   `(provider, model)` rows are added with today's `effective_at`, existing
   rows are left untouched (price history is append-only via the composite PK).

Long term this should be a daily cron in production; for now it is a manual
sync per the umbrella substream plan.
