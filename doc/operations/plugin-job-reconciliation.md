# Durable plugin-job occurrence claims (active-active plan 004)

## What this is

Plugin scheduled/manual job dispatch used to be coordinated only by
in-process state: a plain `SELECT` for due jobs, a process-local `activeJobs`
`Set` for overlap prevention, and an unconditional `queued -> running` write.
That is invisible to any second Paperclip process, so it cannot be the basis
for running more than one replica against the same database — two replicas
would both claim the same due tick, or a manual trigger could race a
scheduled one.

Slice 004 adds `plugin_job_occurrences`, following the same lease/fence
contract slice 003 established for `heartbeat_runs` (see
`doc/operations/run-ownership.md`):

| Column | Meaning |
|---|---|
| `kind` | `"scheduled"` (a cron tick) or `"manual"` (an operator/API trigger). |
| `scheduled_for` | The `nextRunAt` tick this occurrence reserves. `NULL` for manual occurrences. |
| `owner_token` | Opaque token identifying the scheduler instance currently holding the occurrence. |
| `fence` | Value pulled from the global `plugin_job_occurrence_fence_seq` sequence at claim/takeover time. Strictly increasing across the whole table. |
| `lease_expires_at` / `lease_renewed_at` | When the current holder's lease is presumed live until, and when it was last renewed. |
| `claim_attempt` | Count of successful claims for this occurrence (1 on first claim, increments on takeover). |
| `acknowledged_at` | Set once the host has actually sent the `runJob` RPC to the worker. See "Acknowledged gate" below. |
| `status` | `"pending"` / `"queued"` / `"running"` while claimed and in flight; a terminal value once resolved (`"succeeded"`, `"failed"`, `"cancelled"`, or `"unknown"`). |

A partial unique index, `plugin_job_occurrences_scheduled_unique_idx` on
`(job_id, scheduled_for) WHERE kind = 'scheduled'`, makes "one due tick
creates one logical execution across replicas" a database-enforced fact, not
an application convention. Manual occurrences are exempt — each explicit
trigger is its own occurrence, guarded instead by a live-claim check inside
the same claiming transaction.

Migration: `packages/db/src/migrations/0218_condemned_shooting_star.sql`.

## Correctness contract

A caller is authorized to mutate an occurrence's durable state **only**
while holding an `{ ownerToken, fence }` pair minted for it by
`claimDueOccurrences`/`claimManualOccurrence` (fresh claim) or
`takeoverExpiredOccurrence` (reconciliation takeover). That pair must be
captured **once**, immutably, at the moment the claim is won, and threaded
through every subsequent write for that occurrence — never re-read off a
later `SELECT`, which after a takeover reflects the new owner, not the
original caller. `plugin-job-scheduler.ts`'s `executeClaimedRun` enforces
this structurally: it receives the already-claimed `ClaimedOccurrence` (not a
`jobId`/`occurrenceId` it would re-fetch) and threads the same `claim`
through acknowledge, lease renewal, and completion.

Every fenced mutation compares **both** `owner_token` and `fence`, mirroring
plan 003's reasoning: `fence` moves on every takeover even if a bug elsewhere
left `owner_token` aliased.

Lease-expiry decisions (`takeoverExpiredOccurrence`, `findExpiredOccurrences`)
compare against PostgreSQL's own `now()`, not the caller's wall clock, so two
replicas racing a takeover cannot disagree because of clock skew.

## `nextRunAt` advancement is inside the claim transaction

`claimDueOccurrences` reserves the due occurrence **and** advances
`plugin_jobs.next_run_at` in the same transaction (see
`plugin-job-claims-store.ts`). There is no separate post-dispatch "advance
the pointer" step — `plugin-job-scheduler.ts`'s `computeNextRunAtForJob` is
only a pure cron-computation callback passed into the claim transaction, not
a place that writes anything. A crash at any point after the claim
transaction commits therefore cannot lose or duplicate the schedule advance;
a crash before it commits leaves both the claim and the pointer exactly as
they were.

## Acknowledged gate — safe lifecycle revoke vs. drain

`acknowledged_at` is set by `acknowledgeOccurrence` immediately before the
`runJob` RPC is actually dispatched to the worker (see `executeClaimedRun`).
This is the dividing line for `revokeUnacknowledgedOccurrences`
(`plugin-job-scheduler.ts`'s `unregisterPlugin`, called on plugin
disable/unload):

- **`acknowledged_at IS NULL`** — the worker was never asked to do anything.
  Safe to force-cancel; `revokeUnacknowledgedOccurrences` sets the occurrence
  and its run to `"cancelled"`.
- **`acknowledged_at` set** — the `runJob` RPC may already be in flight, or
  the worker may have already performed an irreversible side effect.
  `revokeUnacknowledgedOccurrences` deliberately leaves these rows alone;
  they drain via their own completion path (`executeClaimedRun`'s
  `completeOccurrence` call), the same as if the plugin were still running.

This directly replaces the old `unregisterPlugin`, which blindly cancelled
every `"running"`/`"queued"` run for the plugin regardless of whether the
worker RPC had actually been sent — a real risk of misrepresenting an
execution that was already underway (or already committed an irreversible
side effect) as cancelled.

## No blind replay — the `"unknown"` outcome

There is no idempotency-key or status-probe surface on the plugin job RPC
protocol today (see PLUGIN_SPEC.md §13.6): a plugin's `runJob` handler is a
synchronous request/response call, and there is no separate way to ask "did
this already run to completion?" after the connection is lost. Because of
this, `takeoverExpiredOccurrence` **never** re-dispatches `runJob` on an
expired-lease takeover. It only lets a reconciler transition the occurrence
(and its run) to the terminal `"unknown"` status, added to
`PLUGIN_JOB_RUN_STATUSES` specifically for this case — a deliberate,
operator-visible "we don't know what happened" outcome rather than either a
silent loss or an automatic (possibly duplicate) retry.

`PluginJobContext` (the object passed to a plugin's job handler) now carries
`occurrenceId` and `fence` alongside the existing fields. This is a
forward-looking idempotency surface a plugin author can use for their own
side-effect deduplication — it does **not** change host replay behavior; the
host still never auto-replays.

## Store API — `server/src/services/plugin-job-claims-store.ts`

- `OccurrenceClaim = { ownerToken, fence }` — the immutable claim type.
- `claimDueOccurrences(db, { now, limit, isEligible?, computeNextRunAt })` —
  transactional: `SELECT ... FOR UPDATE SKIP LOCKED` on due `plugin_jobs`
  rows, an `isEligible` filter for local pressure (concurrency cap, worker
  liveness — applied to locked rows before any write, so a skip leaves
  nothing durable), then claim-insert + `nextRunAt` advance + run creation,
  all in one transaction.
- `claimManualOccurrence(db, { jobId, trigger?, leaseTtlMs?, now? })` —
  transactional: `SELECT ... FOR UPDATE` on the job row, a live-claim check
  (any non-expired, non-terminal occurrence for the job), then an atomic
  insert. Returns `null` if the job doesn't exist, isn't active, or already
  has a live claim.
- `acknowledgeOccurrence(db, { occurrenceId, claim })` — fenced, sets
  `status: "running"` and `acknowledged_at`. See the acknowledged-gate
  section above.
- `renewOccurrenceLease(db, { occurrenceId, claim, leaseTtlMs? })` — fenced
  lease extension. Called periodically while a `runJob` RPC is in flight
  (`plugin-job-scheduler.ts`'s `startLeaseRenewal`, every
  `max(5s, leaseTtlMs/3)`) so a long-running job's lease survives well past
  the base TTL without being reaped out from under it.
- `completeOccurrence(db, { occurrenceId, claim, runId, status, error?, durationMs? })`
  — transactional fenced dual-write (occurrence + run). Returns `null` —
  never throws — on a stale/superseded claim. Callers MUST treat `null` as
  "reject this completion" (log + leave the row as whatever the current
  owner set), never as "retry" or "apply anyway" — this is exactly the
  stale-callback case this slice exists to close.
- `isOccurrenceClaimStale(db, { occurrenceId, claim })` — reread-and-compare,
  for callers that want to check before logging a rejection.
- `findExpiredOccurrences(db, { graceMs?, limit? })` — read-only
  reconciliation scan, DB-clock based, oldest first.
- `takeoverExpiredOccurrence(db, { occurrenceId, graceMs? })` — the real
  takeover: mints a fresh owner/fence purely so the takeover itself is
  fenced (a competing reconciler cannot double-resolve the same row), then
  immediately settles the occurrence and its run at `"unknown"`. See "No
  blind replay" above.
- `revokeUnacknowledgedOccurrences(db, { pluginId, reason })` — bulk-cancel
  only `acknowledged_at IS NULL` rows for a plugin. See the acknowledged-gate
  section above.
- `describeStaleOccurrenceRejection({ occurrenceId, claim, context })` — one
  telemetry shape, one event name
  (`plugin_job.occurrence.stale_completion_rejected`), used everywhere a
  fenced write is rejected.

**Raw-SQL row shape trap**: `claimDueOccurrences`, `claimManualOccurrence`,
`takeoverExpiredOccurrence` use `db.execute(sql\`...\`)` for statements the
query builder can't express (sequence-backed `INSERT ... ON CONFLICT`,
`UPDATE ... WHERE lease_expires_at < now() - interval`). That bypasses
Drizzle's column mapping — rows come back keyed by raw Postgres column names
with `bigint`/`timestamptz` columns as raw strings. Every raw-SQL helper here
normalizes through `normalizeOccurrenceRow` before returning; any new
raw-SQL helper added to this file must do the same.

## STOP conditions (do not enable a second replica until these are closed)

Per the plan, HA must not be enabled while:

1. **A plugin can perform irreversible work without an idempotency/status
   probe.** This remains unresolved — see "No blind replay" above. Nothing
   in this slice adds a status-probe RPC; `occurrenceId`/`fence` on
   `PluginJobContext` are an idempotency-key surface a plugin *can* opt into
   using, not a host-enforced guarantee.
2. Since (1) is unresolved, this project must stay single-replica; a second
   replica reclaiming an expired occurrence lease today has no way to know
   whether the plugin's side effect already happened — fencing prevents
   corrupting the *occurrence row*, not duplicating the *plugin's work*, and
   `takeoverExpiredOccurrence` deliberately settles to `"unknown"` rather
   than guessing either way.
3. ~~No production periodic reconciliation sweep~~ **Closed** by the I7
   remediation: `plugin-job-scheduler.ts`'s `start()` now also runs a second
   `setInterval` loop (`reconciliationIntervalMs`, default 60s) that calls
   `findExpiredOccurrences`/`takeoverExpiredOccurrence` for occurrences whose
   lease has lapsed by more than `reconciliationGraceMs` (default 30s,
   slack around the lease-renewal cadence). Bounded to 100 rows/sweep; a
   larger backlog is picked up on the next sweep. It never re-dispatches —
   same terminal-`"unknown"` settlement as a manual `takeoverExpiredOccurrence`
   call. Lease renewal during an in-flight RPC (`startLeaseRenewal`) still
   covers the "long job, healthy executor" case; this sweep is what recovers
   the "executor crashed outright, no renewal loop ever ran" case that used
   to require an operator to run `findExpiredOccurrences` by hand.

Escalate against
[paperclip#6](https://github.com/valkyriweb/paperclip/issues/6) before
enabling a second replica.

## Maintenance notes

- New durable writers for an occurrence must accept and check an
  `OccurrenceClaim` via this store's helpers — enforce this in review, not
  by convention.
- Any new raw `db.execute(sql\`...\`)` helper against
  `plugin_job_occurrences` must route its result through
  `normalizeOccurrenceRow` (see the raw-SQL row shape trap above) rather than
  casting directly to `PluginJobOccurrenceRow`.
- Re-run `server/src/__tests__/plugin-job-claims.test.ts` (includes
  two-connection race/takeover/stale-completion/crash-simulation/revoke
  coverage) after any change to occurrence claim semantics, scheduler
  dispatch flow, or lease timing.
