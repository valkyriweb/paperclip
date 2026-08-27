import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";
import type { PluginJobStatus, PluginJobRunStatus, PluginJobRunTrigger } from "@paperclipai/shared";

// `plugin_job_occurrence_fence_seq` (bigint) is created directly in the
// migration SQL, not declared here as a drizzle schema object — mirroring
// `heartbeat_run_fence_seq` from plan 003 (see heartbeat_runs.ts). It backs
// the monotonic `fence` column on `plugin_job_occurrences` below: every
// claim/takeover mints a strictly higher value than any prior claim across
// the whole table, so a stale holder's writes can always be detected by
// comparing against the fence currently on the row.

/**
 * `plugin_jobs` table — registration and runtime configuration for
 * scheduled jobs declared by plugins in their manifests.
 *
 * Each row represents one scheduled job entry for a plugin. The
 * `job_key` matches the key declared in the manifest's `jobs` array.
 * The `schedule` column stores the cron expression or interval string
 * used by the job scheduler to decide when to fire the job.
 *
 * Status values:
 * - `active` — job is enabled and will run on schedule
 * - `paused` — job is temporarily disabled by the operator
 * - `error` — job has been disabled due to repeated failures
 *
 * @see PLUGIN_SPEC.md §21.3 — `plugin_jobs`
 */
export const pluginJobs = pgTable(
  "plugin_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** FK to the owning plugin. Cascades on delete. */
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    /** Identifier matching the key in the plugin manifest's `jobs` array. */
    jobKey: text("job_key").notNull(),
    /** Cron expression (e.g. `"0 * * * *"`) or interval string. */
    schedule: text("schedule").notNull(),
    /** Current scheduling state. */
    status: text("status").$type<PluginJobStatus>().notNull().default("active"),
    /** Timestamp of the most recent successful execution. */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** Pre-computed timestamp of the next scheduled execution. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginIdx: index("plugin_jobs_plugin_idx").on(table.pluginId),
    nextRunIdx: index("plugin_jobs_next_run_idx").on(table.nextRunAt),
    uniqueJobIdx: uniqueIndex("plugin_jobs_unique_idx").on(table.pluginId, table.jobKey),
  }),
);

/**
 * `plugin_job_runs` table — immutable execution history for plugin-owned jobs.
 *
 * Each row is created when a job run begins and updated when it completes.
 * Rows are never modified after `status` reaches a terminal value
 * (`succeeded` | `failed` | `cancelled`).
 *
 * Trigger values:
 * - `scheduled` — fired automatically by the cron/interval scheduler
 * - `manual` — triggered by an operator via the admin UI or API
 *
 * @see PLUGIN_SPEC.md §21.3 — `plugin_job_runs`
 */
export const pluginJobRuns = pgTable(
  "plugin_job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** FK to the parent job definition. Cascades on delete. */
    jobId: uuid("job_id")
      .notNull()
      .references(() => pluginJobs.id, { onDelete: "cascade" }),
    /** Denormalized FK to the owning plugin for efficient querying. Cascades on delete. */
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    /** Company scope — NULL for instance-level jobs. */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    /** What caused this run to start (`"scheduled"` or `"manual"`). */
    trigger: text("trigger").$type<PluginJobRunTrigger>().notNull(),
    /** Current lifecycle state of this run. */
    status: text("status").$type<PluginJobRunStatus>().notNull().default("pending"),
    /** Wall-clock duration in milliseconds. Null until the run finishes. */
    durationMs: integer("duration_ms"),
    /** Error message if `status === "failed"`. */
    error: text("error"),
    /** Ordered list of log lines emitted during this run. */
    logs: jsonb("logs").$type<string[]>().notNull().default([]),
    /**
     * FK to the fenced claim that authorized this run (active-active
     * reforge plan 004). Nullable only for historical rows predating this
     * column; every run created after plan 004 has one. Completion writes
     * are fenced against `plugin_job_occurrences.owner_token`/`fence`, not
     * against this run row directly — see plugin-job-claims-store.ts.
     */
    occurrenceId: uuid("occurrence_id").references((): AnyPgColumn => pluginJobOccurrences.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    jobIdx: index("plugin_job_runs_job_idx").on(table.jobId),
    pluginIdx: index("plugin_job_runs_plugin_idx").on(table.pluginId),
    companyIdx: index("plugin_job_runs_company_idx").on(table.companyId),
    statusIdx: index("plugin_job_runs_status_idx").on(table.status),
    occurrenceIdx: index("plugin_job_runs_occurrence_idx").on(table.occurrenceId),
  }),
);

/**
 * `plugin_job_occurrences` table — durable, fenced claim on one logical
 * plugin-job execution (active-active reforge plan 004).
 *
 * Where `plugin_jobs` holds the job *definition* and `plugin_job_runs` holds
 * the worker-visible execution record, `plugin_job_occurrences` is the
 * ownership envelope that makes "which replica may dispatch this due tick
 * or manual trigger" a fact in PostgreSQL rather than in-process state
 * (`activeJobs`). It follows the same lease/fence contract as
 * `heartbeat_runs` from plan 003 (see doc/operations/run-ownership.md):
 *
 * - `ownerToken` identifies the scheduler instance that currently holds the
 *   occurrence.
 * - `fence` is minted from `plugin_job_occurrence_fence_seq` on every
 *   claim/takeover and is strictly increasing across the whole table.
 * - `leaseExpiresAt`/`leaseRenewedAt` bound how long a claim is presumed
 *   live by the DB's own clock. Expiry makes loss operator-visible; it is
 *   NOT proof the previous holder stopped working, so nothing here
 *   auto-replays a plugin's `runJob` side effect on takeover — see
 *   plugin-job-claims-store.ts's `takeoverExpiredOccurrence`.
 *
 * `kind` distinguishes a cron-scheduled tick (`"scheduled"`) from an
 * operator-initiated trigger (`"manual"`). Only scheduled occurrences carry
 * a `scheduledFor` value, and the partial unique index on
 * `(job_id, scheduled_for)` is what makes "one due occurrence creates one
 * logical execution across replicas" a database-enforced fact rather than
 * an application-level convention.
 *
 * @see doc/operations/plugin-job-reconciliation.md
 */
export const pluginJobOccurrences = pgTable(
  "plugin_job_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** FK to the job definition. Cascades on delete. */
    jobId: uuid("job_id")
      .notNull()
      .references(() => pluginJobs.id, { onDelete: "cascade" }),
    /** Denormalized FK to the owning plugin. Cascades on delete. */
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    /** What kind of occurrence this is. */
    kind: text("kind").$type<"scheduled" | "manual">().notNull(),
    /**
     * The `nextRunAt` tick this occurrence reserves. NULL for manual
     * occurrences (each manual trigger is its own occurrence — see the
     * partial unique index below, which only constrains `kind = 'scheduled'`
     * rows).
     */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    /** Current holder of this occurrence's claim, or NULL once released. */
    ownerToken: text("owner_token"),
    /** Monotonic fence minted from plugin_job_occurrence_fence_seq. */
    fence: bigint("fence", { mode: "number" }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseRenewedAt: timestamp("lease_renewed_at", { withTimezone: true }),
    claimAttempt: integer("claim_attempt").notNull().default(0),
    /**
     * Set once the host has actually sent the `runJob` RPC to the worker.
     * Before this is set, revoking the occurrence (plugin disable/unload)
     * is safe — the plugin was never asked to do anything. After this is
     * set, the occurrence must be left to drain via its own completion
     * path; force-cancelling it would misrepresent an execution that may
     * already be underway. See `revokeUnacknowledgedOccurrences`.
     */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    /**
     * Outcome of this occurrence. `"pending"`/`"queued"`/`"running"` while
     * claimed and in flight; a terminal value once resolved. `"unknown"` is
     * the deliberate non-replay outcome for a lost/ambiguous execution —
     * see the module doc above.
     */
    status: text("status").$type<PluginJobRunStatus>().notNull().default("pending"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    jobIdx: index("plugin_job_occurrences_job_idx").on(table.jobId),
    pluginIdx: index("plugin_job_occurrences_plugin_idx").on(table.pluginId),
    // Reconciliation scan mirroring heartbeat_runs_status_lease_expires_idx:
    // claimed rows whose lease has lapsed, oldest first.
    statusLeaseExpiresIdx: index("plugin_job_occurrences_status_lease_expires_idx").on(
      table.status,
      table.leaseExpiresAt,
    ),
    // Enforces "one due occurrence creates one logical execution across
    // replicas" — only constrains scheduled ticks; manual triggers are
    // exempt (each is its own occurrence).
    uniqueScheduledOccurrenceIdx: uniqueIndex("plugin_job_occurrences_scheduled_unique_idx")
      .on(table.jobId, table.scheduledFor)
      .where(sql`${table.kind} = 'scheduled'`),
  }),
);
