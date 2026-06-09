import { z } from "zod";
import { BILLING_TYPES } from "../constants.js";

/**
 * Upper bound for `occurredAt`: 1 hour in the future. Tolerates routine
 * clock skew between Paperclip and remote emitters (laptop sleep, sidecar
 * NTP drift, response-header timestamps from upstream providers) while
 * rejecting obvious bugs:
 *
 *   - emitter passing UNIX seconds to `new Date(...)` (off by 1000x → year 7000+)
 *   - emitter using PST clock then converting to UTC wrong (off by 8h)
 *   - replay tool reusing a staged event with its original future timestamp
 *
 * Future-dated cost events poison every dashboard window that filters by
 * occurredAt and can never be aged out by retention; the bound is a one-line
 * guardrail. Substream: agent-system/PAPERCLIP-BUDGET-INTEGRATION.md G2.
 */
const MAX_FUTURE_OCCURRED_AT_MS = 60 * 60 * 1000;

export const createCostEventSchema = z.object({
  agentId: z.string().uuid(),
  issueId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  heartbeatRunId: z.string().uuid().optional().nullable(),
  // Free-text logical-grouping label (e.g. "mission:alpha"). NOT unique:
  // multiple events can share a billing_code for cost aggregation.
  billingCode: z.string().optional().nullable(),
  // Per-event idempotency key for retry-safe upserts. When present, the
  // server uses ON CONFLICT (company_id, idempotency_key) DO UPDATE so
  // retries from external emitters replay onto the same row instead of
  // double-inserting. Format is biller-defined and namespace-prefixed
  // (e.g. "claude-bridge:<request-id>", "multica:<task-id>:<provider>:<model>").
  idempotencyKey: z.string().min(1).optional().nullable(),
  provider: z.string().min(1),
  biller: z.string().min(1).optional(),
  billingType: z.enum(BILLING_TYPES).optional().default("unknown"),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative().optional().default(0),
  cachedInputTokens: z.number().int().nonnegative().optional().default(0),
  // Anthropic cache *write* tokens (distinct from cache reads in
  // cachedInputTokens). Optional for backward-compat with callers built
  // against the pre-0084 schema.
  cacheCreationInputTokens: z.number().int().nonnegative().optional().default(0),
  outputTokens: z.number().int().nonnegative().optional().default(0),
  // costCents is now optional: when omitted (or 0) the server computes
  // from model_pricing. Callers that already know the cost (e.g. heartbeat
  // forwarding Anthropic's response total) keep passing it explicitly.
  costCents: z.number().int().nonnegative().optional(),
  occurredAt: z
    .string()
    .datetime()
    .refine(
      (value) => Date.parse(value) <= Date.now() + MAX_FUTURE_OCCURRED_AT_MS,
      { message: "occurredAt must not be more than 1 hour in the future" },
    ),
}).transform((value) => ({
  ...value,
  biller: value.biller ?? value.provider,
}));

export type CreateCostEvent = z.infer<typeof createCostEventSchema>;

export const updateBudgetSchema = z.object({
  budgetMonthlyCents: z.number().int().nonnegative(),
});

export type UpdateBudget = z.infer<typeof updateBudgetSchema>;
