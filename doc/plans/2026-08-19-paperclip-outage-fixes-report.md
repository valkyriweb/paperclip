# Paperclip outage amplifiers — fix report

Date: 2026-08-19
Lane: `paperclip-outage-fixes` (branch `lue/paperclip-outage-fixes`)
PR: https://github.com/valkyriweb/paperclip/pull/110
Inputs (not re-derived): `doc/plans/2026-08-18-paperclip-perf-triage-verdict.md` (a260f4868),
`doc/plans/2026-08-18-timeout-diagnosis-application-side.md` (5bc4d6531)

## What was fixed

| # | Amplifier | Change | Measured effect it targets |
|---|---|---|---|
| 1 | 9 idle `postgres.js` connections never closed, so PostgreSQL *smart* shutdown blocked its full 180s timeout | `createDb()` sets `idle_timeout` 10s / `max_lifetime` 1800s, env-overridable | ~181s primary outage per failover → seconds |
| 2 | `heartbeat timer tick failed` logged an empty error payload every 30s | `describeError()` + message in the log line | 98 undiagnosable errors per 49-min pod lifetime become diagnosable |
| 3 | `connectTimeoutMs = Math.min(timeoutMs, 15_000)` hard cap | explicit `connectTimeoutMs` config key; classification-driven retry with exponential backoff; connect failures recorded as `failed` + `openclaw_gateway_connect_timeout` | 46 of 277 historical timeouts (connect bursts during gateway pod recycling) |

## Value justification (objective 1)

Measured workload from the verdict docs: bursty 30s heartbeat ticks, 0–2 concurrent
queries against a default pool of 10, 8–17 total connections against `max_connections`
100 — never saturated. So the pool is oversized for the work, and closing idle members
costs nothing in throughput.

- `idle_timeout` **10s**: shorter than the 30s tick cadence, so the pool fully drains
  between ticks and a smart shutdown finds no idle sessions to wait on; long enough that
  one tick's own sequence of queries reuses a warm connection. Reconnect cost is ~1–2
  connects per 30s against an in-cluster Postgres.
- `max_lifetime` **1800s**: bounds a continuously-busy connection so it still rotates
  after a primary change, without meaningful churn.
- Both overridable (`PAPERCLIP_DB_IDLE_TIMEOUT_SEC`, `PAPERCLIP_DB_MAX_LIFETIME_SEC`);
  `0` restores the previous never-close behaviour.
- Pool `max` deliberately untouched, per the brief.

## Negative / notable findings

- **No negative finding on postgres.js.** The repo pins `postgres@^3.4.9` (3.4.9 installed),
  which supports both `idle_timeout` and `max_lifetime`. No fallback was needed.
- **No DB migration needed for objective 3.** `heartbeat_runs.error_code` is a free-text
  column and `status` is a text column validated against `HEARTBEAT_RUN_STATUSES` in
  `packages/shared`. Rather than add a new enum member (which would ripple through DB,
  shared validators, server filters and UI for a smallest-diff brief), connect failures are
  recorded as `failed` with the distinct `error_code = openclaw_gateway_connect_timeout`.
  That satisfies "distinct from run overruns" — run overruns remain `timed_out` — without
  a schema/contract change. If a first-class `connect_failed` status is wanted later, this
  is the natural seam.
- **Retry already partly existed.** `execute.ts` had an ad-hoc 2-retry linear backoff keyed
  off substring matching. It was replaced by, not duplicated with, classification-driven
  retry; default attempt count is unchanged (3 total).

## Verification

- `pnpm -r typecheck` — Done, all packages.
- `pnpm test:run` — 235/236 files, 2071 tests pass, 1 skipped.
- `pnpm build` — Done, all packages.
- New tests: `packages/db/src/pool-timeouts.test.ts`, `server/src/__tests__/describe-error.test.ts`,
  and new suites in `packages/adapters/openclaw-gateway/src/server/execute.test.ts` (24 tests).
- **Pre-existing failure, not from this lane:**
  `server/src/__tests__/workspace-runtime.test.ts > realizeExecutionWorkspace > writes an
  isolated repo-local Paperclip config and worktree branding when provisioning` fails with
  `source local_encrypted secrets key was not found ... master.key`. Verified by stashing
  the entire change and re-running on a clean tree, where it fails identically.

## Not done / out of scope

- CNPG `smartShutdownTimeout` 180 → 20s and `isolationCheck` tuning: `lue-kube` lane.
- Nothing was deployed or restarted; no k8s/manifest change; no dependency upgrade;
  `timeoutSec` defaults for agents untouched.
- The fixes are validated by tests and static reasoning, not by observing a real failover —
  that requires a deploy, which the brief forbids.
