-- 0084_budget_pricing.sql
-- Substream: Paperclip budget integration (PAPERCLIP-BUDGET-INTEGRATION.md, P2).
--
-- 1. model_pricing: canonical per-model token pricing, source of truth for
--    server-side cost computation. Seeded from Vercel AI Gateway. Append-only
--    via (provider, model, effective_at) composite PK so historical cost_events
--    can be re-priced deterministically.
-- 2. cost_events.cache_creation_input_tokens: separate cache-write counter,
--    distinct from cached_input_tokens (which is cache *reads*). Anthropic
--    bills these at a different rate.
-- 3. cost_events partial unique index on (company_id, billing_code): retry-safe
--    idempotency for sources that emit with a stable billing_code (claude-bridge
--    HTTP-direct, Multica forwarder, local CLI scraper). Existing heartbeat-
--    driven rows keep billing_code = NULL and are excluded from the constraint.

CREATE TABLE IF NOT EXISTS "model_pricing" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"input_cpm_micros" bigint DEFAULT 0 NOT NULL,
	"cached_input_cpm_micros" bigint DEFAULT 0 NOT NULL,
	"cache_write_cpm_micros" bigint DEFAULT 0 NOT NULL,
	"output_cpm_micros" bigint DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'vercel-ai-gateway' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_pricing_pk" PRIMARY KEY ("provider","model","effective_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_pricing_lookup_idx"
	ON "model_pricing" USING btree ("provider","model","effective_at");
--> statement-breakpoint
ALTER TABLE "cost_events"
	ADD COLUMN IF NOT EXISTS "cache_creation_input_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_events_company_billing_code_uq"
	ON "cost_events" USING btree ("company_id","billing_code")
	WHERE "billing_code" IS NOT NULL;
