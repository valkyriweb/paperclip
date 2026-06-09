import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    issueId: uuid("issue_id").references(() => issues.id),
    projectId: uuid("project_id").references(() => projects.id),
    goalId: uuid("goal_id").references(() => goals.id),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id),
    // Logical-grouping label (e.g. 'mission:alpha'). Free-text, NOT unique.
    // Multiple cost_events can share a billing_code so the orchestration cost
    // summary can aggregate by mission/project/business-unit.
    billingCode: text("billing_code"),
    // Per-event idempotency key for retry-safe upserts from external emitters
    // (claude-bridge request-id, Multica taskID:provider:model, Pi extension
    // session-message). Partial unique index below; NULL rows (legacy
    // heartbeat path) are excluded so the existing writer path stays untouched.
    idempotencyKey: text("idempotency_key"),
    provider: text("provider").notNull(),
    biller: text("biller").notNull().default("unknown"),
    billingType: text("billing_type").notNull().default("unknown"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    // Cache *write* tokens (Anthropic prompt-caching billing line, distinct
    // from cache reads). Stored separately because cache writes are billed at
    // a different rate per model and must be priced through model_pricing.
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOccurredIdx: index("cost_events_company_occurred_idx").on(table.companyId, table.occurredAt),
    companyAgentOccurredIdx: index("cost_events_company_agent_occurred_idx").on(
      table.companyId,
      table.agentId,
      table.occurredAt,
    ),
    companyProviderOccurredIdx: index("cost_events_company_provider_occurred_idx").on(
      table.companyId,
      table.provider,
      table.occurredAt,
    ),
    companyBillerOccurredIdx: index("cost_events_company_biller_occurred_idx").on(
      table.companyId,
      table.biller,
      table.occurredAt,
    ),
    companyHeartbeatRunIdx: index("cost_events_company_heartbeat_run_idx").on(
      table.companyId,
      table.heartbeatRunId,
    ),
    // Idempotency: retried emissions from any source (claude-bridge, Multica
    // forwarder, local CLI scraper) can replay the same logical event with
    // the same idempotency_key. Partial index — idempotency_key is nullable,
    // NULL rows (e.g. existing heartbeat-driven rows) are excluded so the
    // legacy writer path stays untouched. createEvent uses ON CONFLICT …
    // DO UPDATE on this index to overwrite-on-replay rather than double-insert.
    // (Originally tried using billing_code; that's a free-text grouping label
    // shared across multiple events for a mission. Separated in 0085.)
    companyIdempotencyKeyUq: uniqueIndex("cost_events_company_idempotency_key_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  }),
);
