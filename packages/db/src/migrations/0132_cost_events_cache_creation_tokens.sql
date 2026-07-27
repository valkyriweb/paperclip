-- Cache *write* tokens are billed at a premium (Anthropic: 1.25x input) and were
-- never persisted: no adapter wrote them and the drizzle schema did not map them.
--
-- The column already exists on some deployments, added out-of-band without a
-- migration -- production carries it with no matching entry here or in any
-- snapshot. IF NOT EXISTS makes this converge either way and brings the column
-- back under schema control, so a future drizzle generate cannot decide it is
-- unknown drift and drop it.
ALTER TABLE "cost_events"
  ADD COLUMN IF NOT EXISTS "cache_creation_input_tokens" integer DEFAULT 0 NOT NULL;
