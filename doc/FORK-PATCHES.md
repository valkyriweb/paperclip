# Fork patches

This file records local operational patches that may not be upstream yet.

## 2026-06-09 — Lean heartbeat run backups and indexes

Production Paperclip degraded during Smilerite issue reconciliation after Postgres became CPU-saturated and restarted. Evidence from `pg_stat_activity` and logs showed pressure around `heartbeat_runs`:

- database backups used `COPY public.heartbeat_runs TO STDOUT`;
- `heartbeat_runs` was ~984 MB with only ~4.3k rows because `context_snapshot` and `result_json` store large prompt/session/result payloads;
- company heartbeat list endpoints read recent rows and derive small summaries from those JSON fields;
- live-run lookups filter by `context_snapshot ->> 'issueId'`.

Patch:

- default logical backups nullify `public.heartbeat_runs.context_snapshot` and `public.heartbeat_runs.result_json`;
- add indexes for common heartbeat-run access paths:
  - `heartbeat_runs(company_id, created_at)`;
  - `heartbeat_runs(status, created_at)`;
  - `heartbeat_runs(company_id, status, (context_snapshot ->> 'issueId'), created_at)` for issue-linked runs.

Trade-off:

- DR restores keep heartbeat-run metadata, status, timestamps, logs pointers, costs, and liveness columns, but lose historical full run context/result payloads. This is intentional: those payloads are debugging artifacts, not required to restore the control plane.

Remove this patch when upstream has equivalent backup payload pruning and heartbeat-run indexes.
