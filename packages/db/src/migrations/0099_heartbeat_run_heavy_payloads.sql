CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_created_idx" ON "heartbeat_runs" ("company_id", "created_at");
CREATE INDEX IF NOT EXISTS "heartbeat_runs_status_created_idx" ON "heartbeat_runs" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_status_issue_created_idx" ON "heartbeat_runs" ("company_id", "status", (("context_snapshot" ->> 'issueId')), "created_at") WHERE "context_snapshot" ? 'issueId';
