import { sql } from "drizzle-orm";
import { type AnyPgColumn, pgTable, uuid, text, timestamp, jsonb, index, integer, bigint, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";

export const heartbeatRuns = pgTable(
  "heartbeat_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    invocationSource: text("invocation_source").notNull().default("on_demand"),
    triggerDetail: text("trigger_detail"),
    status: text("status").notNull().default("queued"),
    responsibleUserId: text("responsible_user_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    wakeupRequestId: uuid("wakeup_request_id").references(() => agentWakeupRequests.id),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    usageJson: jsonb("usage_json").$type<Record<string, unknown>>(),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    sessionIdBefore: text("session_id_before"),
    sessionIdAfter: text("session_id_after"),
    logStore: text("log_store"),
    logRef: text("log_ref"),
    logBytes: bigint("log_bytes", { mode: "number" }),
    logSha256: text("log_sha256"),
    logCompressed: boolean("log_compressed").notNull().default(false),
    stdoutExcerpt: text("stdout_excerpt"),
    stderrExcerpt: text("stderr_excerpt"),
    errorCode: text("error_code"),
    externalRunId: text("external_run_id"),
    processPid: integer("process_pid"),
    processGroupId: integer("process_group_id"),
    processStartedAt: timestamp("process_started_at", { withTimezone: true }),
    lastOutputAt: timestamp("last_output_at", { withTimezone: true }),
    lastOutputSeq: integer("last_output_seq").notNull().default(0),
    lastOutputStream: text("last_output_stream"),
    lastOutputBytes: bigint("last_output_bytes", { mode: "number" }),
    retryOfRunId: uuid("retry_of_run_id").references((): AnyPgColumn => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    processLossRetryCount: integer("process_loss_retry_count").notNull().default(0),
    scheduledRetryAt: timestamp("scheduled_retry_at", { withTimezone: true }),
    scheduledRetryAttempt: integer("scheduled_retry_attempt").notNull().default(0),
    scheduledRetryReason: text("scheduled_retry_reason"),
    issueCommentStatus: text("issue_comment_status").notNull().default("not_applicable"),
    issueCommentSatisfiedByCommentId: uuid("issue_comment_satisfied_by_comment_id"),
    issueCommentRetryQueuedAt: timestamp("issue_comment_retry_queued_at", { withTimezone: true }),
    livenessState: text("liveness_state"),
    livenessReason: text("liveness_reason"),
    continuationAttempt: integer("continuation_attempt").notNull().default(0),
    lastUsefulActionAt: timestamp("last_useful_action_at", { withTimezone: true }),
    nextAction: text("next_action"),
    contextSnapshot: jsonb("context_snapshot").$type<Record<string, unknown>>(),
    // Durable leased ownership (active-active run fencing, plan 003). ownerToken
    // identifies the executor holding the run; fence is a globally monotonic
    // value minted from heartbeat_run_fence_seq on every claim/takeover, so a
    // stale holder's writes can be rejected by comparing against the current
    // row rather than trusting process-local state. leaseExpiresAt/leaseRenewedAt
    // gate reconciliation visibility only — expiry never proves the previous
    // holder actually stopped (see doc/operations/run-ownership.md).
    ownerToken: text("owner_token"),
    fence: bigint("fence", { mode: "number" }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseRenewedAt: timestamp("lease_renewed_at", { withTimezone: true }),
    claimAttempt: integer("claim_attempt").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStartedIdx: index("heartbeat_runs_company_agent_started_idx").on(
      table.companyId,
      table.agentId,
      table.startedAt,
    ),
    companyResponsibleUserIdx: index("heartbeat_runs_company_responsible_user_idx").on(
      table.companyId,
      table.responsibleUserId,
      table.createdAt,
    ),
    companyLivenessIdx: index("heartbeat_runs_company_liveness_idx").on(
      table.companyId,
      table.livenessState,
      table.createdAt,
    ),
    companyStatusLastOutputIdx: index("heartbeat_runs_company_status_last_output_idx").on(
      table.companyId,
      table.status,
      table.lastOutputAt,
    ),
    // Serves getLatestIssueRun(ForAgent): latest run whose context_snapshot issueId
    // matches, without detoasting every row (see migration 0131).
    companyIssueCreatedIdx: index("heartbeat_runs_company_issue_created_idx").on(
      table.companyId,
      sql`(${table.contextSnapshot}->>'issueId')`,
      sql`${table.createdAt} DESC`,
      sql`${table.id} DESC`,
    ),
    companyStatusProcessStartedIdx: index("heartbeat_runs_company_status_process_started_idx").on(
      table.companyId,
      table.status,
      table.processStartedAt,
    ),
    companyCreatedAtDescIdx: index("heartbeat_runs_company_created_at_desc_idx").on(
      table.companyId,
      table.createdAt.desc(),
    ),
    companyCtxIssueCreatedIdx: index("heartbeat_runs_company_ctx_issue_created_idx").on(
      table.companyId,
      sql`(${table.contextSnapshot} ->> 'issueId')`,
      table.createdAt.desc(),
    ),
    companyCtxTaskCreatedIdx: index("heartbeat_runs_company_ctx_task_created_idx").on(
      table.companyId,
      sql`(${table.contextSnapshot} ->> 'taskId')`,
      table.createdAt.desc(),
    ),
    companyCtxTaskKeyCreatedIdx: index("heartbeat_runs_company_ctx_taskkey_created_idx").on(
      table.companyId,
      sql`(${table.contextSnapshot} ->> 'taskKey')`,
      table.createdAt.desc(),
    ),
    // Second OR branch of valuesForIssue (run-secret-redaction.ts). Without it
    // the whole predicate is disqualified from a BitmapOr and falls back to a
    // Seq Scan that detoasts context_snapshot. No created_at: the query has no
    // ORDER BY and no LIMIT, so a sort key would only cost writes.
    companyCtxPaperclipIssueIdx: index("heartbeat_runs_company_ctx_paperclip_issue_idx").on(
      table.companyId,
      sql`((${table.contextSnapshot} -> 'paperclipIssue') ->> 'id')`,
    ),
    // Reconciliation scan for run-ownership-store.findExpiredLeaseRuns: running
    // rows whose lease has lapsed, oldest first.
    statusLeaseExpiresIdx: index("heartbeat_runs_status_lease_expires_idx").on(
      table.status,
      table.leaseExpiresAt,
    ),
  }),
);
