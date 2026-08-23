# ADR 0002 — `heartbeat_runs.result_json` retention: trim oversized outputs in place

- Status: Accepted
- Date: 2026-08-20
- Related: ADR 0001 (run-log lifecycle) — the sibling decision for the *file* side of the same data

## Context

`heartbeat_runs.result_json` is the structured result of an agent run: session
bookkeeping, retry timestamps, summary fields, and — for adapters that capture
them — the run's `stdout` and `stderr` as plain strings.

A small number of runs return enormous outputs. Measured on production
(Postgres 17.10), `heartbeat_runs` is **7,455 MB, of which 7,328 MB (98%) is the
TOAST heap**. **4,713 runs older than 30 days hold 4,237 MB** of oversized
`result_json` — **56% of the TOAST heap in 0.6% of the rows**. The largest single
row is 4,123 kB. This is the same shape as the run-log problem ADR 0001 solved,
displaced into the database: a few tenants' verbose runs dominate shared storage.

The important asymmetry: **the API has never served those blobs.**
`heartbeatRunSafeResultJsonColumn` already projects any row over
`HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES` (64 KiB) down to
`left(stdout, HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS)` (4,096 chars) and the same
for `stderr`, and hands back only a whitelist of the remaining fields. The bytes
are stored, backed up, and paid for, but never read.

## Decision

A periodic in-process sweeper (`services/heartbeat-result-retention.ts`) makes
the **stored** row match what readers have always seen, for runs past
`retentionDays` (default 30). It rewrites `stdout`/`stderr` to the same
`keepOutputChars` prefix the API projection uses, and stamps the row with
`truncated` / `truncationReason: 'retention_trimmed'` / `originalSizeBytes` /
`stdoutTruncated` / `stderrTruncated` / `retentionTrimmedAt`.

**Trim, do not null.** `result_json` is not display-only. Several live code paths
read individual keys with no age bound: `resolveExplicitResumeSessionOverride`
reads `.sessionId` for an arbitrary `resumeFromRunId`; the recovery service reads
`.retryNotBefore` / `.transientRetryNotBefore` / `.providerQuotaRetryNotBefore`;
run-liveness reads `.stdout` / `.stderr`; activity and feedback read the summary
fields. Nulling the column would break every one of those, and the damage would
be **self-concealing** — a nulled row stops matching `result_json IS NOT NULL`,
so it never reappears in a re-run of the selector that would have found it.
Trimming preserves every key; only two string values get shorter. A trimmed row
also drops back under the API's size gate, so readers see *more* of it than
before (the whole object rather than the oversized-row whitelist).

**The selector never touches the TOAST payload.** Candidates are chosen with
`pg_column_size(result_json) > maxBytes`, which reads the TOAST *pointer* in the
main heap tuple. Any `->>` on the column instead forces a full detoast +
decompress of every row the scan considers: measured on production, the identical
200-row page took **0.749 s** with the size predicate and **36.778 s** with a
`->>` predicate (49x). The "is there anything actually trimmable here" test
therefore lives in the UPDATE, which only touches ids the selector already
returned.

**Forward-only `(created_at, id)` cursor.** A row can be oversized for a reason
this sweeper cannot fix — bulk in some field that is neither `stdout` nor
`stderr`. Such a row is selected, not modified, and stays a candidate. With a
plain `LIMIT` the sweep would re-select the same page forever; ordering by
`(created_at, id)` and walking past the last row seen guarantees progress with no
marker column and no `->>` predicate. Those rows are reported as **`residue`**
(`examined - trimmed`); a persistently non-zero residue means something else in
`result_json` has grown large and needs its own look.

**`jsonb_set_lax`, not `jsonb_set`.** `jsonb_set` is STRICT: a NULL `new_value`
makes it return NULL for the **whole** document (`create_if_missing = false`
governs the path, not a null value), which would wipe the session and retry
bookkeeping. Each field is rewritten only when it is genuinely an over-long
string; otherwise the `case` yields NULL and
`jsonb_set_lax(..., false, 'return_target')` leaves the document untouched. An
outer `coalesce(..., h.result_json)` is a second belt for the same failure.

**`updated_at` is preserved deliberately.** This is storage maintenance, not a
change to the run. Bumping it would reorder every "recently updated" view and
make months-old runs look freshly active.

**Knobs** (env, resolved in `config.ts`; the sweeper reads one resolved config):

- `PAPERCLIP_RUN_RESULT_RETENTION_ENABLED` — set to `false` to stop the sweeper.
  On by default, because the growth it prevents is unbounded and it only trims
  output the API has never served; the switch exists because the rewrite is
  irreversible, and an operator who wants those tails kept must be able to stop
  it without editing code. Compared with `=== "false"` rather than `!== "true"`,
  so a typo'd value leaves retention running rather than silently off.
- `PAPERCLIP_RUN_RESULT_RETENTION_DAYS` (default 30) — runs younger than this are
  never touched.
- `PAPERCLIP_RUN_RESULT_RETENTION_INTERVAL_MS` (default 24h; first sweep ~60s
  after boot, staggered against the run-log archiver's 30s).
- `PAPERCLIP_RUN_RESULT_RETENTION_BATCH_SIZE` (default 200 candidate rows per
  batch).
- `PAPERCLIP_RUN_RESULT_RETENTION_ITEM_LIMIT` (default 2000 batches per sweep) —
  bounds one sweep, not the backlog.

The size gate and the output cap are **not** configurable. They are pinned to
`HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES` and
`HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS` so the stored row and the served row
cannot disagree about what "oversized" means. A unit test asserts the headroom
invariant — worst-case trimmed size (both outputs at the cap plus the stamped
metadata, ~8.7 KB) must stay well under the gate (64 KiB), or every trimmed row
would remain a permanent candidate.

## Consequences

- **The trimmed tail is gone for good.** For runs past the window whose archived
  log is also gone (`log_store = 'missing'`, ~6,100 runs today) there is no other
  copy of `stdout`/`stderr` beyond the first 4,096 characters. This is the
  deliberate trade, and it is why the default window is generous and the cap
  matches what the API would have shown anyway.
- **Space returns to the free space map, not to the operating system.** The TOAST
  heap is insert-ordered with live recent data at the tail, so a plain `VACUUM`
  makes the freed pages reusable but does not shrink the files. Actually
  returning the ~4 GB to the filesystem needs `pg_repack` or `VACUUM FULL`, which
  is a separate, scheduled, owner-approved operation. The sweeper stops the
  growth and makes the space reusable; it does not by itself reduce disk usage.
- **The selector is a sequential scan.** All thirteen indexes on `heartbeat_runs`
  are company-scoped; none is on `created_at` alone. Plain `EXPLAIN` gives Seq
  Scan + Sort, cost 3670.77, est 3412 rows — about 0.75 s over the 3,500-page main
  heap. Acceptable for a daily job: steady state is one or two scans, and residue
  rows re-page but the cursor still terminates. No index was added because
  `pg_column_size` is not indexable and `CREATE INDEX CONCURRENTLY` cannot run
  inside a migration transaction.
- **Overlapping sweeps are suppressed, not queued.** A tick that fires while the
  previous sweep is still walking returns `skipped: 'already_running'`. Each batch
  detoasts up to `batchSize` multi-megabyte values, so a second concurrent cursor
  walk over the same rows would only compete for I/O.
- **Rows the sweeper cannot help are visible, not silent.** `residue` is logged
  every sweep. It is the signal that some *other* field has become the bulk, which
  would need its own decision rather than a wider trim here.

## Alternatives rejected

- **Null `result_json` past the window.** Cheapest write and the largest reclaim,
  but it breaks resume, retry scheduling, and run-liveness for older runs, and the
  breakage hides itself (see above). Not worth it for the extra few hundred bytes
  per row.
- **Delete old rows.** `heartbeat_runs` is the run history the UI, activity feed,
  and billing views read. The rows are small; the *outputs* are the problem.
- **Archive the outputs to S3 alongside the run logs (extend ADR 0001).** The full
  `stdout`/`stderr` for these runs is already in the run log, which already has a
  cold tier. Adding a second, differently-keyed copy of the same bytes would grow
  total storage to protect a tail nothing reads.
- **An expression index on `pg_column_size(result_json)`.** Not indexable, and even
  a `created_at` index would help only the ordering, not the size filter, which
  must still be evaluated per row. A ~0.75 s daily scan does not justify a
  fourteenth index on a hot table.
- **`VACUUM FULL` / `pg_repack` alone.** Reclaims today's bloat and nothing else:
  without a retention rule the table is back at 7 GB in a few months. The two are
  complementary — this ADR stops the growth, a repack recovers the historical
  bloat.
