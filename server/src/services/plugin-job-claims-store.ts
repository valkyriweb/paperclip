import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginJobs, pluginJobRuns, pluginJobOccurrences } from "@paperclipai/db";
import type { PluginJobRunStatus, PluginJobRunTrigger } from "@paperclipai/shared";
import { DEFAULT_LEASE_TTL_MS, mintOwnerToken } from "./run-ownership-store.js";

/**
 * PluginJobClaimsStore — durable, fenced occurrence claims for plugin
 * scheduled/manual jobs (active-active reforge plan 004).
 *
 * Before this store existed, `plugin-job-scheduler.ts` selected due rows
 * with a plain SELECT, suppressed duplicates only via a process-local
 * `activeJobs` Set, and unconditionally marked runs `running` — none of
 * which coordinates across replicas. This store makes "which replica may
 * dispatch this due tick or manual trigger" a fact in PostgreSQL:
 *
 * - Reserving a due occurrence and advancing `plugin_jobs.next_run_at`
 *   happen in one transaction (`claimDueOccurrences`), so a crash between
 *   claim and pointer-advance is impossible — either both happened or
 *   neither did.
 * - `plugin_job_occurrences.owner_token`/`fence` follow the exact
 *   lease/fence contract `run-ownership-store.ts` established in plan 003
 *   (see that file's header comment for the full correctness contract).
 *   Callers here must capture `{ ownerToken, fence }` once at claim time
 *   and thread that same value through every subsequent write for the
 *   occurrence — never re-read it off a later SELECT.
 * - Expired-lease takeover (`takeoverExpiredOccurrence`) NEVER re-dispatches
 *   the plugin's `runJob` — it only lets a reconciler transition the
 *   occurrence to the terminal `"unknown"` outcome so the loss is
 *   operator-visible. No idempotency/status-probe surface exists on the
 *   plugin job SDK today (see PLUGIN_SPEC.md §13.6), so blind replay would
 *   risk a duplicate irreversible side effect — this store must never do
 *   that automatically. The `occurrenceId` threaded into every `runJob` RPC
 *   (see plugin-job-scheduler.ts) is a stable key a plugin author *can* use
 *   for their own idempotency going forward.
 */

export const DEFAULT_OCCURRENCE_LEASE_TTL_MS = DEFAULT_LEASE_TTL_MS;

/** The claim identity a caller must capture once and thread immutably. */
export type OccurrenceClaim = { ownerToken: string; fence: number | null };

export type PluginJobOccurrenceRow = typeof pluginJobOccurrences.$inferSelect;
export type PluginJobRow = typeof pluginJobs.$inferSelect;
export type PluginJobRunRow = typeof pluginJobRuns.$inferSelect;

export interface ClaimedOccurrence {
  occurrence: PluginJobOccurrenceRow;
  job: PluginJobRow;
  run: PluginJobRunRow;
  claim: OccurrenceClaim;
}

function toClaim(occurrence: PluginJobOccurrenceRow): OccurrenceClaim {
  return { ownerToken: occurrence.ownerToken!, fence: occurrence.fence };
}

/**
 * Whether `jobId` currently has a live (unresolved, unexpired) occurrence of
 * ANY kind — scheduled or manual. Both claim paths must check this under the
 * same `plugin_jobs` row lock (`FOR UPDATE`) they already take, so "one job
 * executes at a time" holds across manual/scheduled overlap, not just
 * within a single kind. The partial unique index only dedupes same-tick
 * scheduled occurrences; it says nothing about a manual trigger racing a
 * scheduled tick (or vice versa) for the same job.
 */
async function hasLiveOccurrence(txDb: Db, jobId: string): Promise<boolean> {
  const [live] = await txDb
    .select({ id: pluginJobOccurrences.id })
    .from(pluginJobOccurrences)
    .where(
      and(
        eq(pluginJobOccurrences.jobId, jobId),
        sql`${pluginJobOccurrences.status} in ('pending', 'queued', 'running')`,
        sql`${pluginJobOccurrences.leaseExpiresAt} > now()`,
      ),
    )
    .limit(1);
  return Boolean(live);
}

function claimCondition(occurrenceId: string, claim: OccurrenceClaim) {
  return and(
    eq(pluginJobOccurrences.id, occurrenceId),
    eq(pluginJobOccurrences.ownerToken, claim.ownerToken),
    claim.fence === null
      ? sql`${pluginJobOccurrences.fence} is null`
      : eq(pluginJobOccurrences.fence, claim.fence),
  );
}

/**
 * Overfetch multiplier applied to `input.limit` when selecting due-job
 * candidates for `claimDueOccurrences`, so that oldest-first rows blocked by
 * `isEligible` or `hasLiveOccurrence` don't permanently starve later,
 * actually-claimable due jobs out of the batch (see that function's doc).
 */
const DUE_CANDIDATE_OVERFETCH_FACTOR = 4;

/** Hard ceiling on due-job candidates fetched per `claimDueOccurrences` call, independent of `limit` or the overfetch factor, to bound query/lock cost. */
const DUE_CANDIDATE_OVERFETCH_HARD_MAX = 100;

/**
 * Atomically reserve up to `limit` due scheduled occurrences and advance
 * each job's `next_run_at` pointer in the same transaction. Uses
 * `SELECT ... FOR UPDATE SKIP LOCKED` on `plugin_jobs` so two racing
 * transactions never process the same job row concurrently — the loser
 * simply skips a locked row and, once the winner commits, no longer finds
 * it due (next_run_at has moved past `now()`). The partial unique index on
 * `(job_id, scheduled_for)` is a second, independent guarantee against the
 * same logical tick ever getting two occurrence rows. A third check,
 * `hasLiveOccurrence`, guards the case those two don't cover: a manual
 * trigger's claim transaction commits (releasing the row lock) long before
 * its execution finishes, so a scheduled tick could otherwise claim the row
 * lock afterward and dispatch a second, overlapping run for the same job.
 *
 * `computeNextRunAt` stays a caller-supplied callback (rather than living
 * in this store) so cron parsing remains owned by plugin-job-scheduler.ts —
 * this store only needs "what's the next tick", not how cron works.
 *
 * **Candidate overfetch (starvation fix)**: the candidate SELECT fetches up
 * to `limit * DUE_CANDIDATE_OVERFETCH_FACTOR` rows (capped at
 * `DUE_CANDIDATE_OVERFETCH_HARD_MAX`), not just `limit` — but `limit` itself
 * is still the hard cap on how many occurrences this call actually claims
 * (the loop below breaks once `claimed.length >= input.limit`). Without the
 * overfetch, the oldest `limit` due rows are locked and iterated in
 * `next_run_at` order; if enough of the oldest rows are blocked by
 * `isEligible` (local concurrency cap, worker not running) or
 * `hasLiveOccurrence` (I4 overlap guard), every later — otherwise
 * claimable — due job in that same batch starves permanently: the same
 * oldest-first rows get re-selected and re-skipped on every subsequent
 * tick, while jobs behind them in `next_run_at` order never get a chance to
 * be evaluated at all.
 */
export async function claimDueOccurrences(
  db: Db,
  input: {
    now: Date;
    limit: number;
    leaseTtlMs?: number;
    /**
     * Local-pressure filter (concurrency cap, worker liveness, overlap
     * prevention) applied to each locked candidate row before it is
     * claimed. Rows that fail this check are left untouched — the row lock
     * is released on commit without a write, so nothing durable changes and
     * the row remains due for a later tick or another replica.
     */
    isEligible?: (job: PluginJobRow) => boolean;
    computeNextRunAt: (job: PluginJobRow, scheduledFor: Date) => Date | null;
  },
): Promise<ClaimedOccurrence[]> {
  const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_OCCURRENCE_LEASE_TTL_MS;

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;

    // See "Candidate overfetch" in the module doc above: fetch more
    // candidates than `limit` so rows blocked by isEligible/hasLiveOccurrence
    // can't starve later, claimable due jobs out of the batch. `limit`
    // itself remains the cap on how many occurrences are actually claimed.
    const candidateLimit = Math.max(
      input.limit,
      Math.min(input.limit * DUE_CANDIDATE_OVERFETCH_FACTOR, DUE_CANDIDATE_OVERFETCH_HARD_MAX),
    );

    const dueJobs = await txDb
      .select()
      .from(pluginJobs)
      .where(and(eq(pluginJobs.status, "active"), lte(pluginJobs.nextRunAt, input.now)))
      .orderBy(asc(pluginJobs.nextRunAt))
      .limit(candidateLimit)
      .for("update", { skipLocked: true });

    const claimed: ClaimedOccurrence[] = [];

    for (const job of dueJobs) {
      if (claimed.length >= input.limit) break;

      if (input.isEligible && !input.isEligible(job)) continue;

      // Manual/scheduled overlap guard: a manual trigger claimed on another
      // replica (or by this one) may still be live — its claim transaction
      // already committed, releasing the `plugin_jobs` row lock, well before
      // its execution finishes. Without this check a scheduled tick could
      // claim and dispatch a second concurrent run for the same job.
      if (await hasLiveOccurrence(txDb, job.id)) continue;

      const scheduledFor = job.nextRunAt!;
      const ownerToken = mintOwnerToken();

      // ON CONFLICT DO NOTHING is defense in depth (see module doc) — under
      // the FOR UPDATE SKIP LOCKED lock above this should always insert.
      const occurrenceRows = (await txDb.execute(sql`
        INSERT INTO plugin_job_occurrences
          (job_id, plugin_id, kind, scheduled_for, owner_token, fence, lease_expires_at, lease_renewed_at, status, claim_attempt)
        VALUES
          (${job.id}, ${job.pluginId}, 'scheduled', ${scheduledFor.toISOString()}, ${ownerToken},
           nextval('plugin_job_occurrence_fence_seq'),
           now() + (${leaseTtlMs}::text || ' milliseconds')::interval, now(), 'pending', 1)
        ON CONFLICT (job_id, scheduled_for) WHERE kind = 'scheduled' DO NOTHING
        RETURNING *
      `)) as unknown as Array<Record<string, unknown>>;

      const occurrenceRow = occurrenceRows[0];
      if (!occurrenceRow) continue;
      const occurrence = normalizeOccurrenceRow(occurrenceRow);

      const nextRunAt = input.computeNextRunAt(job, scheduledFor);
      const [updatedJob] = await txDb
        .update(pluginJobs)
        .set({ lastRunAt: scheduledFor, nextRunAt, updatedAt: input.now })
        .where(eq(pluginJobs.id, job.id))
        .returning();

      const [run] = await txDb
        .insert(pluginJobRuns)
        .values({
          jobId: job.id,
          pluginId: job.pluginId,
          trigger: "schedule",
          status: "queued",
          occurrenceId: occurrence.id,
        })
        .returning();

      claimed.push({ occurrence, job: updatedJob!, run: run!, claim: toClaim(occurrence) });
    }

    return claimed;
  });
}

/**
 * Atomically claim a manual trigger for `jobId`, refusing if the job is
 * inactive or already has a live (unexpired) claimed occurrence — scheduled
 * or manual. `SELECT ... FOR UPDATE` on the job row serializes racing
 * triggers so the "already running" check and the insert are one atomic
 * unit; unlike scheduled occurrences, manual ones are not deduplicated by a
 * unique index (each explicit trigger is its own occurrence), only
 * overlap-guarded.
 *
 * Returns `null` if the job doesn't exist, isn't active, or already has a
 * live claim — callers should surface this as "already running" /
 * "not found", mirroring the scheduler's prior in-memory checks.
 */
export async function claimManualOccurrence(
  db: Db,
  input: { jobId: string; trigger?: PluginJobRunTrigger; leaseTtlMs?: number; now?: Date },
): Promise<ClaimedOccurrence | null> {
  const trigger: PluginJobRunTrigger = input.trigger ?? "manual";
  const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_OCCURRENCE_LEASE_TTL_MS;
  const ownerToken = mintOwnerToken();

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;

    const [job] = await txDb
      .select()
      .from(pluginJobs)
      .where(eq(pluginJobs.id, input.jobId))
      .for("update");
    if (!job || job.status !== "active") return null;

    if (await hasLiveOccurrence(txDb, input.jobId)) return null;

    const occurrenceRows = (await txDb.execute(sql`
      INSERT INTO plugin_job_occurrences
        (job_id, plugin_id, kind, scheduled_for, owner_token, fence, lease_expires_at, lease_renewed_at, status, claim_attempt)
      VALUES
        (${job.id}, ${job.pluginId}, 'manual', NULL, ${ownerToken},
         nextval('plugin_job_occurrence_fence_seq'),
         now() + (${leaseTtlMs}::text || ' milliseconds')::interval, now(), 'pending', 1)
      RETURNING *
    `)) as unknown as Array<Record<string, unknown>>;
    const occurrence = normalizeOccurrenceRow(occurrenceRows[0]!);

    const [run] = await txDb
      .insert(pluginJobRuns)
      .values({
        jobId: job.id,
        pluginId: job.pluginId,
        trigger,
        status: "queued",
        occurrenceId: occurrence.id,
      })
      .returning();

    return { occurrence, job, run: run!, claim: toClaim(occurrence) };
  });
}

/**
 * Mark an occurrence as acknowledged — the `runJob` RPC has actually been
 * sent to the worker. Fenced on `claim` like every other write here, AND
 * gated on `status in ('pending', 'queued')` so a revoke that lands between
 * claim and acknowledge cannot be resurrected: `revokeUnacknowledgedOccurrences`
 * does not change `owner_token`/`fence` (only `status`), so without this
 * status guard a race where unregister/disable revokes the occurrence just
 * before the in-flight dispatch acknowledges it would flip an already
 * `"cancelled"` row back to `"running"` — the claim still matches, but the
 * occurrence is no longer live. After this succeeds,
 * `revokeUnacknowledgedOccurrences` will no longer touch the row; only its
 * own completion path (or reconciliation, terminal-only) may resolve it.
 */
export async function acknowledgeOccurrence(
  db: Db,
  input: { occurrenceId: string; claim: OccurrenceClaim },
): Promise<PluginJobOccurrenceRow | null> {
  const rows = await db
    .update(pluginJobOccurrences)
    .set({ status: "running", acknowledgedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        claimCondition(input.occurrenceId, input.claim),
        sql`${pluginJobOccurrences.status} in ('pending', 'queued')`,
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Renew an occurrence's lease. No-ops (returns null) if the claim is stale. */
export async function renewOccurrenceLease(
  db: Db,
  input: { occurrenceId: string; claim: OccurrenceClaim; leaseTtlMs?: number },
): Promise<PluginJobOccurrenceRow | null> {
  const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_OCCURRENCE_LEASE_TTL_MS;
  const rows = await db
    .update(pluginJobOccurrences)
    .set({
      leaseExpiresAt: sql`now() + (${leaseTtlMs}::text || ' milliseconds')::interval`,
      leaseRenewedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(claimCondition(input.occurrenceId, input.claim))
    .returning();
  return rows[0] ?? null;
}

/**
 * Fenced completion: resolve both the occurrence and its run in one
 * statement, conditioned on the caller still holding `claim`. Returns null
 * — never throws — when the claim no longer matches (stale owner/fence,
 * e.g. a takeover already reclaimed this occurrence as `"unknown"` while
 * this RPC call was still in flight). Callers MUST treat null as "reject
 * this completion" (log + leave the row as whatever the current owner set),
 * never as "retry" or "apply anyway" — that is exactly the stale-callback
 * case plan 004 exists to close.
 */
export async function completeOccurrence(
  db: Db,
  input: {
    occurrenceId: string;
    claim: OccurrenceClaim;
    runId: string;
    status: Extract<PluginJobRunStatus, "succeeded" | "failed">;
    error?: string | null;
    durationMs?: number | null;
  },
): Promise<{ occurrence: PluginJobOccurrenceRow; run: PluginJobRunRow } | null> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const now = new Date();
    const [occurrence] = await txDb
      .update(pluginJobOccurrences)
      .set({ status: input.status, resolvedAt: now, updatedAt: now })
      .where(claimCondition(input.occurrenceId, input.claim))
      .returning();
    if (!occurrence) return null;

    const [run] = await txDb
      .update(pluginJobRuns)
      .set({
        status: input.status,
        error: input.error ?? null,
        durationMs: input.durationMs ?? null,
        finishedAt: now,
      })
      .where(eq(pluginJobRuns.id, input.runId))
      .returning();

    return { occurrence, run: run! };
  });
}

/**
 * Reread the row and report whether `claim` is actually stale. Mirrors
 * `isClaimStale` in run-ownership-store.ts — callers should check this
 * before logging a "stale completion rejected" event, since a 0-row CAS can
 * also mean the occurrence id doesn't exist.
 */
export async function isOccurrenceClaimStale(
  db: Db,
  input: { occurrenceId: string; claim: OccurrenceClaim },
): Promise<boolean> {
  const [row] = await db
    .select({ ownerToken: pluginJobOccurrences.ownerToken, fence: pluginJobOccurrences.fence })
    .from(pluginJobOccurrences)
    .where(eq(pluginJobOccurrences.id, input.occurrenceId));
  if (!row) return false;
  return row.ownerToken !== input.claim.ownerToken || row.fence !== input.claim.fence;
}

/**
 * Reconciliation read: claimed (non-terminal) occurrences whose lease has
 * lapsed by more than `graceMs`, oldest first, by PostgreSQL's own clock.
 */
export async function findExpiredOccurrences(
  db: Db,
  input: { graceMs?: number; limit?: number } = {},
): Promise<PluginJobOccurrenceRow[]> {
  const graceMs = input.graceMs ?? 0;
  return db
    .select()
    .from(pluginJobOccurrences)
    .where(
      and(
        sql`${pluginJobOccurrences.status} in ('pending', 'queued', 'running')`,
        sql`${pluginJobOccurrences.leaseExpiresAt} is not null`,
        lte(pluginJobOccurrences.leaseExpiresAt, sql`now() - (${graceMs}::text || ' milliseconds')::interval`),
      ),
    )
    .orderBy(asc(pluginJobOccurrences.leaseExpiresAt))
    .limit(input.limit ?? 100);
}

/**
 * Takeover an occurrence whose lease has genuinely expired (DB clock, same
 * clock-skew reasoning as run-ownership-store.claimExpiredLease). This does
 * NOT hand the occurrence to a new executor to re-run `runJob` — it mints a
 * fresh owner/fence purely so the takeover itself is fenced (a competing
 * reconciler cannot double-resolve the same row), then immediately settles
 * the occurrence at the terminal `"unknown"` outcome and marks its run
 * `"unknown"` too. See module doc for why blind replay is never safe here.
 */
export async function takeoverExpiredOccurrence(
  db: Db,
  input: { occurrenceId: string; graceMs?: number },
): Promise<{ occurrence: PluginJobOccurrenceRow; run: PluginJobRunRow | null } | null> {
  const graceMs = input.graceMs ?? 0;
  const ownerToken = mintOwnerToken();

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const rows = (await txDb.execute(sql`
      UPDATE plugin_job_occurrences
      SET owner_token = ${ownerToken},
          fence = nextval('plugin_job_occurrence_fence_seq'),
          status = 'unknown',
          resolved_at = now(),
          lease_expires_at = null,
          claim_attempt = claim_attempt + 1,
          updated_at = now()
      WHERE id = ${input.occurrenceId}
        AND status in ('pending', 'queued', 'running')
        AND lease_expires_at is not null
        AND lease_expires_at < now() - (${graceMs}::text || ' milliseconds')::interval
      RETURNING *
    `)) as unknown as Array<Record<string, unknown>>;
    const occurrenceRow = rows[0];
    if (!occurrenceRow) return null;
    const occurrence = normalizeOccurrenceRow(occurrenceRow);

    const [run] = await txDb
      .update(pluginJobRuns)
      .set({ status: "unknown", error: "Claim lease expired before completion", finishedAt: new Date() })
      .where(and(eq(pluginJobRuns.occurrenceId, occurrence.id), sql`${pluginJobRuns.status} in ('queued', 'running')`))
      .returning();

    return { occurrence, run: run ?? null };
  });
}

/**
 * Revoke every unacknowledged, unresolved occurrence for a job or plugin
 * (plugin disable/unload). Only rows with `acknowledged_at IS NULL` are
 * touched — the `runJob` RPC was never sent for them, so cancelling is
 * side-effect-safe. Acknowledged occurrences are deliberately left alone;
 * they drain via their own completion path (see module doc).
 */
export async function revokeUnacknowledgedOccurrences(
  db: Db,
  input: { pluginId: string; reason: string },
): Promise<PluginJobOccurrenceRow[]> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const now = new Date();
    const occurrences = await txDb
      .update(pluginJobOccurrences)
      .set({ status: "cancelled" as PluginJobRunStatus, resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(pluginJobOccurrences.pluginId, input.pluginId),
          sql`${pluginJobOccurrences.acknowledgedAt} is null`,
          sql`${pluginJobOccurrences.status} in ('pending', 'queued')`,
        ),
      )
      .returning();

    for (const occurrence of occurrences) {
      await txDb
        .update(pluginJobRuns)
        .set({ status: "cancelled", error: input.reason, finishedAt: now })
        .where(and(eq(pluginJobRuns.occurrenceId, occurrence.id), sql`${pluginJobRuns.status} in ('queued', 'running')`));
    }

    return occurrences;
  });
}

// db.execute(sql`...`) bypasses drizzle's column mapping — rows come back
// keyed by raw Postgres column names, and bigint/timestamptz columns stay
// raw strings. Every raw-SQL helper above must normalize through this,
// mirroring run-ownership-store.ts's normalizeHeartbeatRunRow.
function toCamelCase(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

const BIGINT_NUMBER_FIELDS = new Set(["fence", "claimAttempt"]);

function normalizeOccurrenceRow(row: Record<string, unknown>): PluginJobOccurrenceRow {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = toCamelCase(key);
    if (camelKey === "fence" && typeof value === "string") {
      normalized[camelKey] = Number(value);
    } else if (camelKey.endsWith("At") && typeof value === "string") {
      normalized[camelKey] = new Date(value);
    } else {
      normalized[camelKey] = value;
    }
  }
  return normalized as PluginJobOccurrenceRow;
}

/**
 * Stale-completion rejection telemetry — dedicated call (not an inline
 * `logger.warn`) so it is one grep target and one alertable event name,
 * mirroring `describeStaleOwnershipRejection` in run-ownership-store.ts.
 * Never logs the raw token.
 */
export function describeStaleOccurrenceRejection(input: {
  occurrenceId: string;
  claim: OccurrenceClaim;
  context: string;
}): { event: string; fields: Record<string, unknown> } {
  return {
    event: "plugin_job.occurrence.stale_completion_rejected",
    fields: {
      occurrenceId: input.occurrenceId,
      ownerToken: `${input.claim.ownerToken.slice(0, 8)}…`,
      fence: input.claim.fence,
      context: input.context,
    },
  };
}
