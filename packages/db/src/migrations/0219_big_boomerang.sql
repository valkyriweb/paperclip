CREATE TABLE "live_event_fanout_checkpoints" (
	"replica_id" text PRIMARY KEY NOT NULL,
	"last_delivered_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_event_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin_replica_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "live_event_outbox_company_id_idx" ON "live_event_outbox" USING btree ("company_id","id");--> statement-breakpoint
CREATE INDEX "live_event_outbox_created_at_idx" ON "live_event_outbox" USING btree ("created_at");