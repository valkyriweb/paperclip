# Paperclip outage amplifiers — fix report

Date: 2026-08-19
Lane: `paperclip-outage-fixes` (branch `lue/paperclip-outage-fixes`)
PR: https://github.com/valkyriweb/paperclip/pull/110
Inputs (not re-derived): `doc/plans/2026-08-18-paperclip-perf-triage-verdict.md` (a260f4868),
`doc/plans/2026-08-18-timeout-diagnosis-application-side.md` (5bc4d6531)

## What was fixed

| # | Amplifier | Change | Measured effect it targets |
|---|---|---|---|
| 1 | 9 idle `postgres.js` connections never closed, so PostgreSQL *smart* shutdown blocked its full 180s timeout | `createDb()` sets `idle_timeout` 30s / `max_lifetime` 1800s, both env-overridable (a sibling change landed the same fix on master mid-lane; see "Base drift") | ~181s primary outage per failover → bounded by idle_timeout |
| 2 | `heartbeat timer tick failed` logged an empty error payload every 30s | `describeError()` + message in the log line | 98 undiagnosable errors per 49-min pod lifetime become diagnosable |
| 3 | `connectTimeoutMs = Math.min(timeoutMs, 15_000)` hard cap | explicit `connectTimeoutMs` config key; classification-driven retry with exponential backoff; connect failures recorded as `failed` + `openclaw_gateway_connect_timeout` | 46 of 277 historical timeouts (connect bursts during gateway pod recycling) |

## Value justification (objective 1)

Measured workload from the verdict docs: bursty 30s heartbeat ticks, 0–2 concurrent
queries against a default pool of 10, 8–17 total connections against `max_connections`
100 — never saturated. So the pool is oversized for the work, and closing idle members
costs nothing in throughput.

- `idle_timeout` **30s**: the value landed on master, matching the heartbeat tick cadence,
  so the pool drains shortly after the app goes quiet and a smart shutdown waits at most
  ~30s instead of the full 180s. (This lane's own draft used 10s; the landed value was kept
  rather than overridden, and is now env-tunable for anyone who wants it tighter.)
- `max_lifetime` **1800s**, inherited from the sibling change that landed on master. Self-review
  caught that postgres.js does *not* leave this unbounded — `src/index.js` defaults it to a
  per-connection `60 * (30 + Math.random() * 30)` = random 30–60 minutes. A fixed value
  removes that jitter, so a pool opened at startup expires together. That tradeoff is now
  documented in the code comment and `doc/DATABASE.md`, and the env override lets an
  operator lengthen it or set `0` to fall back to postgres.js's jitter. Not silently
  reverted, because it is landed behaviour from another lane.
- Both overridable (`PAPERCLIP_DB_IDLE_TIMEOUT_SEC`, `PAPERCLIP_DB_MAX_LIFETIME_SEC`);
  `0` disables either timer (postgres.js `timer()` treats 0 as "no timer"), which for
  `idle_timeout` restores the previous never-close behaviour.
- Pool `max` deliberately untouched, per the brief.

## Negative / notable findings

- **postgres.js supports both options** (`postgres@^3.4.9`, 3.4.9 installed); no fallback
  was needed. But the brief's premise was only half right: `idle_timeout` defaults to
  `null` (never closes — this is the real bug), while `max_lifetime` was **already bounded**
  by default to a random 30–60 minutes. Only the idle bound was missing, so only the idle
  bound is set. See "Value justification" above.
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
  new suites in `packages/adapters/openclaw-gateway/src/server/execute.test.ts`, and two
  end-to-end cases in `server/src/__tests__/openclaw-gateway-adapter.test.ts` that drive
  `execute()` at a dead port and assert `timedOut === false` +
  `errorCode === openclaw_gateway_connect_timeout` + the retry budget — proving the
  classification is wired into the adapter result, not just unit-tested in isolation.
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

## Self-review pass (depth: high, 2026-08-19)

Findings from an adversarial audit of this branch against `origin/master`, and their disposition:

- **[P2] `max_lifetime` default removed the upstream jitter.** `packages/db/src/client.ts` —
  first draft pinned 1800s for every connection; postgres.js deliberately randomises 30–60
  min so pooled connections do not expire in lockstep. Fixed: the key is now only sent when
  `PAPERCLIP_DB_MAX_LIFETIME_SEC` is set, and the code comment/doc no longer claim
  postgres.js leaves lifetimes unbounded.
- **[P2] Classification was unit-tested but never wired-tested.** `classifyGatewayFailure()`
  had pure-function coverage while the seam that matters — the value actually returned by
  `execute()` — had none. Fixed with two cases in
  `server/src/__tests__/openclaw-gateway-adapter.test.ts`.
- **[P3] `connectMaxAttempts` / `connectRetryBaseDelayMs` are JSON-only.** They are read from
  `adapterConfig` and documented in `docs/agents-runtime.md`, but unlike `connectTimeoutMs`
  they have no create-form field. Accepted: they are advanced tuning knobs and the create
  form is not the contract for every adapter key.
- **Structural sweep:** `Math.min(timeoutMs, …)` appears at one other site
  (`server/src/services/plugin-worker-manager.ts:1135`, `MAX_RPC_TIMEOUT_MS`) which is a
  bounded RPC ceiling, not a connect budget — out of scope. `createDb()` is the only
  long-lived `postgres()` pool; every other caller uses `max: 1` and ends the connection.
- Axes with no surviving candidates: architecture, dead code, pattern consistency.

## Base drift (rebase onto `origin/master` 8d721a0eb)

While this lane was running, master gained 17 commits, including a sibling fix that landed
the *same* pool change directly in `packages/db/src/client.ts`:

```ts
const POOL_IDLE_TIMEOUT_SECONDS = 30;
const POOL_MAX_LIFETIME_SECONDS = 30 * 60;
```

Both sides were preserved rather than one overwriting the other:

- The landed **values** (30s / 1800s) are kept as the defaults — a sibling lane's deliberate
  choice is not silently reverted.
- This lane's **configurability** (`resolveDbPoolTimeouts()`, the two env vars, tests) and
  its **measurement/jitter documentation** are kept on top.
- The lane's own draft default of 10s idle was dropped in favour of the landed 30s.

Also landed on master mid-lane and relevant to objective 2:
`fix(heartbeat): stop one budget-blocked agent from aborting the whole timer sweep (#106)`
removes one known cause of the empty-payload tick failure. The logging fix in this branch is
still needed — it makes the *remaining* causes diagnosable rather than guessed at.
