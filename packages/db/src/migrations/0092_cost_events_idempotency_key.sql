-- 0085_cost_events_idempotency_key.sql
-- Substream: Paperclip budget integration (PAPERCLIP-BUDGET-INTEGRATION.md, P2 fix-up).
--
-- Adds a dedicated per-event idempotency key column for retry-safe upserts
-- from sources that emit with a stable identifier (claude-bridge request-id,
-- Multica taskID:provider:model, Pi extension session-message). Separate from
-- cost_events.billing_code which is an existing free-text label used for
-- logical grouping ("mission:alpha" across multiple events for cost roll-ups).
--
-- The original 0084 tried to put a UNIQUE constraint on billing_code, which
-- broke plugin-orchestration-apis.test.ts that inserts 3 cost_events sharing
-- billing_code="mission:alpha" as a grouping label. This migration corrects
-- that design clash by giving idempotency its own column.

ALTER TABLE "cost_events"
	ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_events_company_idempotency_key_uq"
	ON "cost_events" USING btree ("company_id","idempotency_key")
	WHERE "idempotency_key" IS NOT NULL;
