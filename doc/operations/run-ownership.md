# Durable heartbeat run ownership (active-active plan 003)

## What this is

Heartbeat run execution used to be coordinated only by in-process state:
`runningProcesses`/`activeRunExecutions` maps and `withAgentStartLock`
(`server/src/services/agent-start-lock.ts`). That is invisible to any second
Paperclip process, so it cannot be the basis for running more than one
replica against the same database.

Slice 003 adds a durable claim and a monotonic fence to `heartbeat_runs`:

| Column | Meaning |
|---|---|
| `owner_token` | Opaque token identifying the executor currently holding the run. `null` when unclaimed or released. |
| `fence` | Value pulled from the global `heartbeat_run_fence_seq` sequence at claim/takeover time. Strictly increasing across every run in the table, so any two fence values are directly comparable — a takeover's fence is always greater than the claim it superseded. |
| `lease_expires_at` / `lease_renewed_at` | When the current holder's lease is presumed live until, and when it was last renewed. |
| `claim_attempt` | Count of successful claims for this run row (1 on first claim, increments on every takeover). |

`heartbeat_run_events.fence` records the fence value under which each
log/lifecycle event was accepted, as an audit trail for reconciliation.

Migration: `packages/db/src/migrations/0217_heartbeat_run_ownership_fencing.sql`.

## Correctness contract

A caller is authorized to mutate a run's durable state **only** while holding
an `{ ownerToken, fence }` pair minted for it by `claimHeartbeatRunSlot`
(fresh claim) or `claimExpiredLease` (takeover). That pair must be captured
**once**, immutably, at the moment the claim is won, and threaded through
every subsequent write for that execution — never re-read off a later
`SELECT` of the row, which after a takeover reflects the new owner, not the
original caller. `executeRun` enforces this structurally: it now takes the
already-claimed row as its parameter (not a `runId` it would re-fetch), binds
`executionClaim` once at entry, and refuses to run at all unless handed a row
that is already `status: "running"` with a non-null `ownerToken`.

Every fenced mutation compares **both** `owner_token` and `fence`, not
`owner_token` alone — defense in depth against a caller that reused a stale
in-memory row whose `ownerToken` field it forgot to refresh; `fence` moves on
every takeover even if a bug elsewhere left `ownerToken` aliased.

Lease-expiry decisions (`claimExpiredLease`, `findExpiredLeaseRuns`) compare
against PostgreSQL's own `now()`, not the caller's wall clock, so two
replicas racing a takeover cannot disagree because of clock skew between
them.

## Store API — `server/src/services/run-ownership-store.ts`

- `mintOwnerToken()` — random opaque token minted on claim/takeover.
- `redactOwnerToken(token)` — first 8 chars + ellipsis; every log/telemetry
  call site uses this, never the raw token (bearer-equivalent for the lease
  window).
- `RunClaim = { ownerToken, fence }` — the immutable claim type.
- `renewLease(db, { runId, claim })` — conditional UPDATE, only extends the
  lease while `claim` still matches the row and status is `"running"`.
- `releaseRunOwnership(db, { runId, claim })` — clears `owner_token`/
  `lease_expires_at`. Deliberately leaves `fence` untouched: it is a
  monotonic audit trail, not a per-run counter. In practice this is folded
  directly into `setRunStatus`/`setRunStatusFromLive`'s own `UPDATE` whenever
  the target status is terminal (see below), rather than called separately.
- `claimExpiredLease(db, { runId, graceMs?, leaseTtlMs? })` — the real
  takeover: a single conditional `UPDATE ... WHERE lease_expires_at < now() -
  grace RETURNING *` that mints a fresh owner token and
  `nextval('heartbeat_run_fence_seq')` atomically. Returns `null` if the
  lease was not actually expired by the DB clock, or if a peer already won
  the race — at most one caller can win a given expired lease.
- `findExpiredLeaseRuns(db, { graceMs?, limit? })` — read-only reconciliation
  query, DB-clock based, oldest first. Exposed on the heartbeat service as
  `listExpiredLeaseRuns(...)`.
- `appendFencedRunEvent(db, { runId, claim, ... })` — atomic
  check-and-insert: a single `WITH lease AS (UPDATE ... RETURNING fence)
  INSERT ... SELECT ... FROM lease` statement, so there is no round-trip gap
  between "is this claim still valid" and "write the event" for a takeover to
  land in. Returns `null` (event dropped, not written) on a stale/superseded
  claim.
- `writeFencedRunPatch(db, { runId, claim, patch })` — generic fenced partial
  update for any other mid-execution field `executeRun` needs to write
  (context snapshot, session bookkeeping); same claim-matching semantics as
  every other helper here.
- `describeStaleOwnershipRejection({ runId, claim, context })` — one
  telemetry shape, one event name
  (`heartbeat.run_ownership.stale_write_rejected`), used everywhere a fenced
  write is rejected, so an operator can alert on this signal alone rather
  than grepping assorted ad hoc warn logs.

`claimHeartbeatRunSlot` (`server/src/services/heartbeat-run-slot.ts`) mints
the owner token and fence inside the same transaction that performs the
concurrency-capped `queued -> running` claim, so a claim and its ownership
are atomic together.

**Raw-SQL row shape trap**: `claimExpiredLease` and `appendFencedRunEvent`
use `db.execute(sql\`...\`)` for statements the query builder can't express.
That bypasses Drizzle's column mapping entirely — rows come back keyed by
raw Postgres column names (`owner_token`, not `ownerToken`), with
`bigint`-mode columns (`fence`, `logBytes`, `lastOutputBytes`) and
`timestamp` columns as raw strings, not numbers/`Date`s. Both helpers
normalize through `normalizeHeartbeatRunRow` before returning; any new raw-SQL
helper added here must do the same or its result will silently mismatch the
`HeartbeatRunRow` type it claims to return. This was caught by the
two-connection integration tests (`run-ownership-store.test.ts`), not by
`tsc` — the cast that made it type-check (`as unknown as HeartbeatRunRow[]`)
hid it.

## What is fenced today

- **Claim** — `claimHeartbeatRunSlot`: atomic capacity check + claim + mint
  owner token/fence/lease, under a per-agent advisory lock.
- **`executeRun` entry** — refuses to execute unless handed an already-claimed
  `status: "running"` row with a non-null `ownerToken`; no internal
  "adopt whatever `getRun(runId)` returns" path exists any more.
- **Log/event writes** — `appendRunEvent`, atomically via
  `appendFencedRunEvent` when the run carries an `ownerToken` (dropped and
  logged as `stale_write_rejected` on a lost claim); falls through to an
  unconditional insert with `fence: null` only for unclaimed/pre-fencing rows.
- **Mid-execution context/session writes inside `executeRun`** — every
  `contextSnapshot` write (runtime services becoming known, environment
  lease resolution, execution-workspace id) and the session-start write
  (`sessionIdBefore`/`startedAt`/`contextSnapshot`) go through
  `writeFencedRunPatch(db, { claim: executionClaim, ... })`. The session-start
  write aborts the run outright on rejection (continuing to launch the
  adapter under a lost claim is exactly the duplicate-execution risk fencing
  exists to prevent); the others log and continue, since the environment/
  workspace bookkeeping they carry is best-effort and getting overwritten by
  a newer owner is the correct outcome, not a failure.
- **Lease renewal** — implicit via every fenced `appendRunEvent`/
  `writeFencedRunPatch` call, since heartbeat execution emits events
  frequently. There is no separate periodic renewal timer; see gap (3) below.
- **Terminal status writes** — `setRunStatus`/`setRunStatusIfRunning`/
  `setRunStatusFromLive` all take an optional `claim: RunClaim`; when passed,
  the `UPDATE` compares both `owner_token` and `fence`, and — whenever the
  target status is terminal — the same statement also clears
  `owner_token`/`lease_expires_at` (release folded into the write, not a
  separate call). A claim mismatch is logged via
  `describeStaleOwnershipRejection` rather than silently succeeding.
- **Orphan reconciliation (`reapOrphanedRuns`)** — the DB-clock app-side
  `lease_expires_at` check is now only a cheap pre-filter; the authoritative
  decision is a real `claimExpiredLease` takeover. A row with an
  `ownerToken` is only written by the reaper after the reaper itself wins
  that takeover (logged as `heartbeat.run_ownership.reaper_took_over_expired_lease`);
  losing the race skips the run for this pass (logged as
  `reaper_takeover_lost_race`) rather than force-writing. This covers both
  the "detached but pid still alive" annotation and the terminal
  `"process_lost"` finalization — there is no longer an unfenced write in
  this function for a claimed row.
- **Operator visibility** — `reapOrphanedRuns` also calls
  `findExpiredLeaseRuns` once per pass after reaping and logs any rows still
  showing an expired lease (in-process-tracked runs it skipped, or rows a
  peer's reaper won concurrently) as
  `heartbeat.run_ownership.expired_lease_visible`, so `listExpiredLeaseRuns`
  has a real periodic consumer rather than being reachable only from ad hoc
  inspection.

## What is deliberately NOT fenced (by design, not oversight)

- **`cancelRunInternal`** (operator/control-plane cancel) and the
  pre-dispatch `cancelQueuedRunFor*` helpers. These must be able to act
  regardless of which executor currently holds the lease — an operator
  cancelling a wedged run, or the scheduler cancelling a run before it is
  ever claimed, is not the split-brain hazard fencing exists to prevent.
  Fencing them would let a genuinely stuck executor block its own
  cancellation.
- **`persistRunProcessMetadata`, `clearDetachedRunWarning`,
  `patchRunIssueCommentStatus`**, the output-progress throttled flush
  (`lastOutputAt`/`lastOutputSeq`/`lastOutputStream`/`lastOutputBytes`), the
  log-handle write (`logStore`/`logRef`), and the issue-execution-lock writes
  outside `claimQueuedRun`'s own transaction. These remain unfenced: they are
  either non-authoritative bookkeeping (log handle pointer, output-progress
  telemetry, explicitly best-effort per its own comment) or, for
  `patchRunIssueCommentStatus`/`persistRunProcessMetadata`, metadata whose
  worst-case staleness is an operator-visible display glitch, not a
  duplicated side effect or corrupted terminal state. Fencing every write in
  the file was not attempted; these were audited and judged low-risk, not
  overlooked — flag if that judgment turns out wrong in practice.
- **`enqueueWakeup`'s same-agent wake-coalescing write** — when a new wake
  arrives for an issue that already has a same-agent execution run in flight,
  `enqueueWakeup` merges the new wake's context into that run's
  `contextSnapshot` (`mergeCoalescedContextSnapshot`) via an unconditional
  `tx.update(heartbeatRuns).set({ contextSnapshot: mergedContextSnapshot, ... }).where(eq(heartbeatRuns.id, ...))`
  and records the wake as `status: "coalesced"`, instead of dispatching a
  second run. This write is not gated on `ownerToken`/`fence` — it runs
  inside `enqueueWakeup`'s own request-side transaction, which has no
  `RunClaim` in scope (a wake request is not an executor holding the run).
  Worst case under a lost/superseded lease is the same class as the other
  entries here: the merged wake context can land on a row a peer's reaper has
  since taken over, so the coalesced wake reason may not be observed by
  whichever executor resumes the run. Not yet fenced or reconciled against
  takeover; flag alongside the other unfenced writers if this turns out to
  drop wakes in practice.

## STOP conditions (do not enable a second replica until these are closed)

Per the plan, HA must not be enabled while:

1. **An adapter has irreversible work without idempotency/status probe.**
   This remains the hard blocker and nothing in this remediation touches it:
   `reapOrphanedRuns`'/`isTrackedLocalChildProcessAdapter`'s local-subprocess
   path still has no way to ask "did this already run to completion?" after a
   lease is lost — a spawned child process is irreversible work with no
   idempotency key. Adopting or re-dispatching a lost local-subprocess run is
   explicitly **out of scope** for this slice (matches plan 003's own scope
   line and STOP condition) and is not implemented here.
   `findExpiredLeaseRuns`/`listExpiredLeaseRuns` and the reaper's takeover
   exist only to make loss visible and to let reconciliation finalize a
   *terminal* outcome under a real claim — never to authorize automatic
   re-execution of adapter work.
2. Since (1) is unresolved, this project must stay single-replica; a second
   replica reclaiming an expired lease today has no way to prevent
   double-dispatching the adapter side effect for a local-subprocess run —
   fencing prevents corrupting the *row*, not duplicating the *process*.
3. No production periodic lease-renewal timer exists independent of event
   traffic. `DEFAULT_LEASE_TTL_MS` (90s) assumes events are frequent enough
   to keep renewing the lease via `appendRunEvent`/`writeFencedRunPatch`. A
   run that goes genuinely silent for longer than the TTL (no adapter
   output, no context write) will have its lease reaped even though the
   process is still alive and eventually resumes writing — at which point
   its immutable `executionClaim` is stale and every further fenced write it
   attempts is correctly rejected as `stale_write_rejected`, but the run
   itself has no way to notice this and stop early. This is a liveness gap
   (a healthy-but-quiet run can lose its claim), not a safety gap (no write
   under a lost claim can land) — explicitly not closed here; a dedicated
   renewal timer independent of event/context traffic would close it.

Escalate against
[paperclip#6](https://github.com/valkyriweb/paperclip/issues/6) before
enabling a second replica.

## Maintenance notes

- New durable writers for a run must accept and check a `RunClaim` via this
  store's helpers (`writeFencedRunPatch`, or `setRunStatus`/
  `setRunStatusFromLive`'s `claim` parameter) — enforce this in review, not by
  convention.
- Any new raw `db.execute(sql\`...\`)` helper against `heartbeat_runs` must
  route its result through `normalizeHeartbeatRunRow` (see the raw-SQL row
  shape trap above) rather than casting directly to `HeartbeatRunRow`.
- Re-run `server/src/services/run-ownership-store.test.ts` (includes
  two-connection race/takeover/stale-write/crash-simulation coverage) after
  any change to run status semantics, adapter execution flow, or lease
  timing.
