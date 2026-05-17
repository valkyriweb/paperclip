import { and, desc, eq, getTableColumns, gte, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies, costEvents, heartbeatRuns, issues, modelPricing, projects } from "@paperclipai/db";
import { computeCostCents as sharedComputeCostCents } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { budgetService, type BudgetServiceHooks } from "./budgets.js";

/**
 * Transport-style providers whose cost should be priced as if they were the
 * underlying billing provider. claude-bridge proxies Anthropic models through
 * Luke's local subscription; attribution stays as 'claude-bridge' on the
 * cost_events row, but the pricing lookup falls back to 'anthropic'.
 */
const PRICING_PROVIDER_ALIASES: Record<string, string> = {
  "claude-bridge": "anthropic",
};

/**
 * Providers that are billed per token against a paid API endpoint. The
 * server-side classifier defaults to `metered_api` for these when the caller
 * did not provide `billingType` (or sent the placeholder `unknown`). External
 * emitters — Multica forwarder, Pi extension, P4b watcher — don't go through
 * Paperclip's adapter framework so they can't run the @paperclipai/adapter-utils
 * classifier; this server-side fallback covers them.
 *
 * Substream: agent-system/PAPERCLIP-BUDGET-INTEGRATION.md G2.
 */
const SERVER_METERED_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "google",
  "google-vertex",
  "amazon-bedrock",
  "azure-openai-responses",
  "deepseek",
  "groq",
  "xai",
  "openrouter",
  "vercel-ai-gateway",
  "mistral",
  "cohere",
  "perplexity",
]);

const SERVER_SUBSCRIPTION_ONLY_PROVIDERS: ReadonlySet<string> = new Set([
  "github-copilot",
]);

/**
 * Server-side billing-type classifier. Pure function over provider only — no
 * env access. Used to fill in `billingType` when the caller didn't set it.
 *
 * Hybrid providers (claude-bridge, openai-codex) deliberately stay `unknown`
 * here: the caller's env determines whether they're metered or subscription,
 * and the server can't see it. Those emitters MUST set `billingType` themselves
 * (claude-bridge does this in pi-claude-bridge/paperclip-billing.js).
 */
export function classifyBillingTypeFromProvider(provider: string | null | undefined): string {
  if (!provider) return "unknown";
  if (SERVER_METERED_PROVIDERS.has(provider)) return "metered_api";
  if (SERVER_SUBSCRIPTION_ONLY_PROVIDERS.has(provider)) return "subscription_included";
  return "unknown";
}

/**
 * Resolve the canonical `model_pricing` provider key for a cost_events row.
 */
function pricingProviderFor(provider: string): string {
  return PRICING_PROVIDER_ALIASES[provider] ?? provider;
}

/**
 * Look up the latest `model_pricing` row whose effective_at <= occurredAt for
 * the given (provider, model). Returns null when there is no matching row.
 *
 * Caller is responsible for transport-aliasing via `pricingProviderFor`.
 */
async function lookupPricing(
  db: Db,
  provider: string,
  model: string,
  occurredAt: Date,
): Promise<{
  inputCpmMicros: number;
  cachedInputCpmMicros: number;
  cacheWriteCpmMicros: number;
  outputCpmMicros: number;
} | null> {
  const [row] = await db
    .select({
      inputCpmMicros: modelPricing.inputCpmMicros,
      cachedInputCpmMicros: modelPricing.cachedInputCpmMicros,
      cacheWriteCpmMicros: modelPricing.cacheWriteCpmMicros,
      outputCpmMicros: modelPricing.outputCpmMicros,
    })
    .from(modelPricing)
    .where(
      and(
        eq(modelPricing.provider, provider),
        eq(modelPricing.model, model),
        lte(modelPricing.effectiveAt, occurredAt),
      ),
    )
    .orderBy(desc(modelPricing.effectiveAt))
    .limit(1);
  return row ?? null;
}

/**
 * Compute the cents cost of a token-priced event from a model_pricing row.
 *
 * Pricing rates are stored as `cpm_micros` = micro-cents per *million* tokens.
 * Multiplying by raw token count therefore gives `(micro-cents × tokens) /
 * million-token`, which is in units of micro-cents × 1e6. Divide by 1e6 to
 * collapse the "per million tokens" factor, then by 1e6 again to convert
 * micro-cents → cents — i.e. divide by 1e12 total.
 *
 * Sanity check: 1_000_000 input tokens at Anthropic Sonnet input rate
 * ($3/Mtok → 300_000_000 cpm_micros) should cost 300¢ = $3.
 *   (1e6 × 3e8) / 1e12 = 3e14 / 1e12 = 300. ✓
 *
 * Math.round before truncation so small charges (sub-cent) round to nearest
 * cent rather than getting clobbered to 0.
 */
/**
 * Re-export from @paperclipai/shared so existing call sites that import
 * `computeCostCents` from this module keep working. The implementation lives
 * in shared so the backfill script (packages/db, which can't depend on
 * server) gets the same math.
 */
export const computeCostCents = sharedComputeCostCents;

export interface CostDateRange {
  from?: Date;
  to?: Date;
}

const METERED_BILLING_TYPE = "metered_api";
const SUBSCRIPTION_BILLING_TYPES = ["subscription_included", "subscription_overage"] as const;

function sumAsNumber(column: typeof costEvents.costCents | typeof costEvents.inputTokens | typeof costEvents.cachedInputTokens | typeof costEvents.outputTokens) {
  return sql<number>`coalesce(sum(${column}), 0)::double precision`;
}

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

async function getMonthlySpendTotal(
  db: Db,
  scope: { companyId: string; agentId?: string | null },
) {
  const { start, end } = currentUtcMonthWindow();
  const conditions = [
    eq(costEvents.companyId, scope.companyId),
    gte(costEvents.occurredAt, start),
    lt(costEvents.occurredAt, end),
  ];
  if (scope.agentId) {
    conditions.push(eq(costEvents.agentId, scope.agentId));
  }
  const [row] = await db
    .select({
      total: sumAsNumber(costEvents.costCents),
    })
    .from(costEvents)
    .where(and(...conditions));
  return Number(row?.total ?? 0);
}

export function costService(db: Db, budgetHooks: BudgetServiceHooks = {}) {
  const budgets = budgetService(db, budgetHooks);
  return {
    createEvent: async (
      companyId: string,
      data: Omit<typeof costEvents.$inferInsert, "companyId" | "costCents"> & {
        costCents?: number | null;
      },
    ) => {
      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, data.agentId))
        .then((rows) => rows[0] ?? null);

      if (!agent) throw notFound("Agent not found");
      if (agent.companyId !== companyId) {
        throw unprocessable("Agent does not belong to company");
      }

      // Fill missing/unknown billingType from provider. External emitters
      // (Multica forwarder, Pi extension, watcher) post tokens without
      // billingType; server-side classifier sets metered_api / subscription_included
      // from the provider name so the dashboard's Billers tab doesn't show
      // `unknown` for known billers (G2).
      const callerBillingType = data.billingType ?? "unknown";
      const billingType =
        callerBillingType === "unknown" ? classifyBillingTypeFromProvider(data.provider) : callerBillingType;
      const inputTokens = data.inputTokens ?? 0;
      const cachedInputTokens = data.cachedInputTokens ?? 0;
      const cacheCreationInputTokens = data.cacheCreationInputTokens ?? 0;
      const outputTokens = data.outputTokens ?? 0;
      const occurredAt = data.occurredAt instanceof Date ? data.occurredAt : new Date(data.occurredAt);

      // Resolve costCents: subscription rows always 0; explicit numeric input wins;
      // otherwise look up the model_pricing row for (aliased provider, model, time)
      // and compute server-side. Falls back to 0 when no pricing row matches —
      // the dashboard then surfaces the gap (zero cost but non-zero tokens) so
      // an operator can add a manual pricing entry.
      let costCents: number;
      if (billingType === "subscription_included") {
        costCents = 0;
      } else if (typeof data.costCents === "number" && data.costCents > 0) {
        costCents = data.costCents;
      } else {
        const pricing = await lookupPricing(db, pricingProviderFor(data.provider), data.model, occurredAt);
        costCents = pricing
          ? computeCostCents(
              { inputTokens, cachedInputTokens, cacheCreationInputTokens, outputTokens },
              pricing,
            )
          : (typeof data.costCents === "number" ? data.costCents : 0);
      }

      const insertValues = {
        ...data,
        companyId,
        biller: data.biller ?? data.provider,
        billingType,
        cachedInputTokens,
        cacheCreationInputTokens,
        costCents,
      };

      // Two write paths:
      //  - billingCode present → ON CONFLICT (company_id, billing_code) DO UPDATE
      //    against the partial unique index added in migration 0084. Retried
      //    emissions from a remote source replay onto the same row instead of
      //    double-inserting.
      //  - billingCode absent (legacy heartbeat path) → plain INSERT, semantics
      //    unchanged.
      // We need to know whether this write inserted a new row or replayed onto
      // an existing billing-code row, so the budget evaluator only fires for
      // genuine new spend (Q18 spec). Postgres exposes this via `xmax`: 0 for
      // a brand-new row, non-zero for an updated row. Smuggle it through
      // RETURNING as a synthetic `inserted` boolean.
      const returning = {
        ...getTableColumns(costEvents),
        inserted: sql<boolean>`(xmax = 0)`.as("inserted"),
      };
      const insertBuilder = db.insert(costEvents).values(insertValues);
      const event = await (data.billingCode
        ? insertBuilder
            .onConflictDoUpdate({
              target: [costEvents.companyId, costEvents.billingCode],
              targetWhere: sql`${costEvents.billingCode} IS NOT NULL`,
              set: {
                inputTokens,
                cachedInputTokens,
                cacheCreationInputTokens,
                outputTokens,
                costCents,
                billingType,
                biller: insertValues.biller,
                provider: data.provider,
                model: data.model,
                occurredAt,
              },
            })
            .returning(returning)
            .then((rows) => rows[0])
        : insertBuilder.returning(returning).then((rows) => rows[0]));

      const [agentMonthSpend, companyMonthSpend] = await Promise.all([
        getMonthlySpendTotal(db, { companyId, agentId: event.agentId }),
        getMonthlySpendTotal(db, { companyId }),
      ]);

      await db
        .update(agents)
        .set({
          spentMonthlyCents: agentMonthSpend,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, event.agentId));

      await db
        .update(companies)
        .set({
          spentMonthlyCents: companyMonthSpend,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));

      // Q18: only evaluate budget thresholds on genuine insert. Replays of an
      // already-recorded billing_code (network retry, idempotency) carry the
      // same final usage numbers in every emitter we ship — re-evaluating is
      // wasted work AND it spams activity_log with duplicate threshold-crossed
      // entries even though createIncidentIfNeeded itself is dedup-safe.
      if (event.inserted) {
        await budgets.evaluateCostEvent(event);
      }

      // Strip the synthetic column before returning to the caller.
      const { inserted: _inserted, ...eventOut } = event;
      return eventOut;
    },

    summary: async (companyId: string, range?: CostDateRange) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const [{ total }] = await db
        .select({
          total: sumAsNumber(costEvents.costCents),
        })
        .from(costEvents)
        .where(and(...conditions));

      const spendCents = Number(total);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (spendCents / company.budgetMonthlyCents) * 100
          : 0;

      return {
        companyId,
        spendCents,
        budgetCents: company.budgetMonthlyCents,
        utilizationPercent: Number(utilization.toFixed(2)),
      };
    },

    issueTreeSummary: async (
      companyId: string,
      issueId: string,
      options: { excludeRoot?: boolean } = {},
    ) => {
      // Callers must resolve and authorize a visible root issue before invoking this.
      // The route does that so zero counts are not mistaken for a missing root.
      const childIssues = alias(issues, "child");

      // The seed of the recursive CTE: when excludeRoot is true, start from
      // the direct children so the root issue itself is not counted.
      const cteSeed = options.excludeRoot
        ? sql`
            SELECT ${issues.id}
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.parentId} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
          `
        : sql`
            SELECT ${issues.id}
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.id} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
          `;

      const cteSeedText = options.excludeRoot
        ? sql`
            SELECT (${issues.id})::text AS id
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.parentId} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
          `
        : sql`
            SELECT (${issues.id})::text AS id
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.id} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
          `;

      const issueTreeCondition = sql<boolean>`
        ${issues.id} IN (
          WITH RECURSIVE issue_tree(id) AS (
            ${cteSeed}
            UNION ALL
            SELECT ${childIssues.id}
            FROM ${issues} ${childIssues}
            JOIN issue_tree ON ${childIssues.parentId} = issue_tree.id
            WHERE ${childIssues.companyId} = ${companyId}
              AND ${childIssues.hiddenAt} IS NULL
          )
          SELECT id FROM issue_tree
        )
      `;

      const runSummarySql = sql`
        WITH RECURSIVE issue_tree(id) AS (
          ${cteSeedText}
          UNION ALL
          SELECT (${childIssues.id})::text
          FROM ${issues} ${childIssues}
          JOIN issue_tree ON (${childIssues.parentId})::text = issue_tree.id
          WHERE ${childIssues.companyId} = ${companyId}
            AND ${childIssues.hiddenAt} IS NULL
        )
        SELECT
          count(distinct ${heartbeatRuns.id})::int AS "runCount",
          coalesce(sum(extract(epoch from (coalesce(${heartbeatRuns.finishedAt}, now()) - ${heartbeatRuns.startedAt})) * 1000), 0)::double precision AS "runtimeMs"
        FROM ${heartbeatRuns}
        WHERE ${heartbeatRuns.companyId} = ${companyId}
          AND ${heartbeatRuns.startedAt} IS NOT NULL
          AND (
            ${heartbeatRuns.contextSnapshot} ->> 'issueId' IN (SELECT id FROM issue_tree)
            OR EXISTS (
              SELECT 1
              FROM ${activityLog}
              JOIN issue_tree ON ${activityLog.entityId} = issue_tree.id
              WHERE ${activityLog.companyId} = ${companyId}
                AND ${activityLog.entityType} = 'issue'
                AND ${activityLog.runId} = ${heartbeatRuns.id}
            )
          )
      `;

      // Run cost-event aggregation and run-duration aggregation in parallel.
      // They're separate queries because cost_events fan out per-event and
      // joining heartbeat_runs through them would double-count run durations.
      const [costRowResult, runRowResult] = await Promise.all([
        db
          .select({
            issueCount: sql<number>`count(distinct ${issues.id})::int`,
            costCents: sumAsNumber(costEvents.costCents),
            inputTokens: sumAsNumber(costEvents.inputTokens),
            cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
            outputTokens: sumAsNumber(costEvents.outputTokens),
          })
          .from(issues)
          .leftJoin(
            costEvents,
            and(
              eq(costEvents.companyId, companyId),
              eq(costEvents.issueId, issues.id),
            ),
          )
          .where(
            and(
              eq(issues.companyId, companyId),
              isNull(issues.hiddenAt),
              issueTreeCondition,
            ),
          ),
        db.execute(runSummarySql),
      ]);

      const costRow = costRowResult[0];
      const runRow = Array.isArray(runRowResult)
        ? (runRowResult[0] as { runCount?: number | string | null; runtimeMs?: number | string | null } | undefined)
        : undefined;

      return {
        issueId,
        issueCount: Number(costRow?.issueCount ?? 0),
        includeDescendants: true,
        costCents: Number(costRow?.costCents ?? 0),
        inputTokens: Number(costRow?.inputTokens ?? 0),
        cachedInputTokens: Number(costRow?.cachedInputTokens ?? 0),
        outputTokens: Number(costRow?.outputTokens ?? 0),
        runCount: Number(runRow?.runCount ?? 0),
        runtimeMs: Number(runRow?.runtimeMs ?? 0),
      };
    },

    byAgent: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          agentStatus: agents.status,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(costEvents.agentId, agents.name, agents.status)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    byProvider: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    byBiller: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          biller: costEvents.biller,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
          providerCount: sql<number>`count(distinct ${costEvents.provider})::int`,
          modelCount: sql<number>`count(distinct ${costEvents.model})::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.biller)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    /**
     * aggregates cost_events by provider for each of three rolling windows:
     * last 5 hours, last 24 hours, last 7 days.
     * purely internal consumption data, no external rate-limit sources.
     */
    windowSpend: async (companyId: string) => {
      const windows = [
        { label: "5h", hours: 5 },
        { label: "24h", hours: 24 },
        { label: "7d", hours: 168 },
      ] as const;

      const results = await Promise.all(
        windows.map(async ({ label, hours }) => {
          const since = new Date(Date.now() - hours * 60 * 60 * 1000);
          const rows = await db
            .select({
              provider: costEvents.provider,
              biller: sql<string>`case when count(distinct ${costEvents.biller}) = 1 then min(${costEvents.biller}) else 'mixed' end`,
              costCents: sumAsNumber(costEvents.costCents),
              inputTokens: sumAsNumber(costEvents.inputTokens),
              cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
              outputTokens: sumAsNumber(costEvents.outputTokens),
            })
            .from(costEvents)
            .where(
              and(
                eq(costEvents.companyId, companyId),
                gte(costEvents.occurredAt, since),
              ),
            )
            .groupBy(costEvents.provider)
            .orderBy(desc(sumAsNumber(costEvents.costCents)));

          return rows.map((row) => ({
            provider: row.provider,
            biller: row.biller,
            window: label as string,
            windowHours: hours,
            costCents: row.costCents,
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            outputTokens: row.outputTokens,
          }));
        }),
      );

      return results.flat();
    },

    byAgentModel: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      // single query: group by agent + provider + model.
      // the (companyId, agentId, occurredAt) composite index covers this well.
      // order by provider + model for stable db-level ordering; cost-desc sort
      // within each agent's sub-rows is done client-side in the ui memo.
      return db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(
          costEvents.agentId,
          agents.name,
          costEvents.provider,
          costEvents.biller,
          costEvents.billingType,
          costEvents.model,
        )
        .orderBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model);
    },

    byProject: async (companyId: string, range?: CostDateRange) => {
      const issueIdAsText = sql<string>`${issues.id}::text`;
      const runProjectLinks = db
        .selectDistinctOn([activityLog.runId, issues.projectId], {
          runId: activityLog.runId,
          projectId: issues.projectId,
        })
        .from(activityLog)
        .innerJoin(
          issues,
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(issues.companyId, companyId),
            isNotNull(activityLog.runId),
            isNotNull(issues.projectId),
          ),
        )
        .orderBy(activityLog.runId, issues.projectId, desc(activityLog.createdAt))
        .as("run_project_links");

      const effectiveProjectId = sql<string | null>`coalesce(${costEvents.projectId}, ${runProjectLinks.projectId})`;
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const costCentsExpr = sumAsNumber(costEvents.costCents);

      return db
        .select({
          projectId: effectiveProjectId,
          projectName: projects.name,
          costCents: costCentsExpr,
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        .leftJoin(runProjectLinks, eq(costEvents.heartbeatRunId, runProjectLinks.runId))
        .innerJoin(projects, sql`${projects.id} = ${effectiveProjectId}`)
        .where(and(...conditions, sql`${effectiveProjectId} is not null`))
        .groupBy(effectiveProjectId, projects.name)
        .orderBy(desc(costCentsExpr));
    },
  };
}
