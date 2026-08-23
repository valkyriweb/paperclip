import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import type { Config } from "../config.js";
import { logger } from "../middleware/logger.js";
import {
  HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS,
  HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES,
} from "./heartbeat-run-summary.js";

/**
 * `heartbeat_runs.result_json` retention sweeper.
 *
 * A handful of agent runs return enormous `stdout`/`stderr` blobs inside
 * `result_json`. They TOAST out of line, and the TOAST heap is where the table's
 * size actually lives.
 *
 * The API has never served those blobs: `heartbeatRunSafeResultJsonColumn`
 * already projects any row over `HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES` down
 * to `left(stdout, HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS)` and the same for
 * `stderr`. This sweeper makes the *stored* row match what readers have always
 * seen, for runs past `retentionDays`.
 *
 * WHY WE TRIM RATHER THAN NULL THE COLUMN. `result_json` is not display-only.
 * `resolveExplicitResumeSessionOverride` reads `.sessionId` for an arbitrary
 * `resumeFromRunId` with no age bound; the recovery service reads
 * `.retryNotBefore` / `.transientRetryNotBefore` / `.providerQuotaRetryNotBefore`;
 * run-liveness reads `.stdout` / `.stderr`; activity and feedback read the
 * summary fields. Nulling the column would silently break every one of those,
 * and the damage would be self-concealing — a nulled row stops matching
 * `result_json IS NOT NULL`, so it never appears in a re-run of the selector
 * that would have found it. Trimming preserves every key; only two string
 * values get shorter, and a trimmed row drops back under the API's size gate so
 * readers see MORE of it than before (the full object rather than the
 * oversized-row whitelist).
 *
 * What is genuinely lost: `stdout`/`stderr` past the first
 * `keepOutputChars` characters, for runs older than `retentionDays`. For runs
 * whose archived log has already gone (`log_store = 'missing'`) that tail is
 * unrecoverable. That is the deliberate trade and it is why the default
 * retention window is generous.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface HeartbeatResultRetentionConfig {
  /** Runs younger than this are never touched. */
  retentionDays: number;
  /** Only rows whose stored `result_json` exceeds this are candidates. */
  maxBytes: number;
  /** Characters of `stdout`/`stderr` kept. Matches the API projection. */
  keepOutputChars: number;
  /** Candidate rows fetched per batch. */
  batchSize: number;
  /** Max batches per sweep. Bounds one sweep's work, not the backlog. */
  itemLimit: number;
}

export interface HeartbeatResultRetentionResult {
  skipped: boolean;
  reason?: string;
  /** Candidate rows inspected (oversized and past the retention window). */
  examined: number;
  /** Rows actually rewritten because `stdout`/`stderr` exceeded the cap. */
  trimmed: number;
  batches: number;
  /**
   * Candidates left alone because neither output field was over the cap — rows
   * that are oversized for some other reason. A persistently non-zero value
   * here means something else in `result_json` has grown large and this sweeper
   * cannot reclaim it.
   */
  get residue(): number;
}

export interface HeartbeatResultRetentionDb {
  /**
   * Oldest-first page of oversized candidates strictly after `cursor`.
   *
   * Deliberately uses only predicates that read the TOAST *pointer*:
   * `pg_column_size` reports the stored size without detoasting, while any
   * `->>` on the column forces a full detoast + decompress of every row the
   * scan considers (measured on production: 0.749s versus 36.778s for the same
   * 200-row page). The "is there anything to trim" test therefore belongs in
   * the UPDATE, which touches only the ids this already returned.
   *
   * `createdAtText` is the row's timestamp in Postgres' own text form, carried
   * back verbatim. It is NOT a `Date` and must never become one — see the
   * cursor note on the driver implementation below.
   */
  selectOversizedPage(input: {
    cutoff: Date;
    maxBytes: number;
    limit: number;
    cursor: { createdAtText: string; id: string } | null;
  }): Promise<Array<{ id: string; createdAtText: string }>>;

  /** Trim `stdout`/`stderr` on the given ids. Returns rows actually rewritten. */
  trimResultJson(input: {
    ids: string[];
    keepOutputChars: number;
    maxBytes: number;
  }): Promise<number>;
}

export interface HeartbeatResultRetentionDeps {
  db: HeartbeatResultRetentionDb;
  config: HeartbeatResultRetentionConfig;
  now: () => Date;
  log?: Pick<typeof logger, "info" | "warn" | "error">;
}

export interface HeartbeatResultRetention {
  runSweep(): Promise<HeartbeatResultRetentionResult>;
}

export function resolveHeartbeatResultRetentionConfig(config: Config): HeartbeatResultRetentionConfig {
  return {
    retentionDays: config.runResultRetentionDays,
    // Deliberately the same threshold the API projection uses, so the stored
    // row and the served row agree on what "oversized" means.
    maxBytes: HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES,
    keepOutputChars: HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS,
    batchSize: config.runResultRetentionBatchSize,
    itemLimit: config.runResultRetentionItemLimit,
  };
}

export function createHeartbeatResultRetention(
  deps: HeartbeatResultRetentionDeps,
): HeartbeatResultRetention {
  const log = deps.log ?? logger;
  // Sweeps are slow (each batch detoasts up to `batchSize` multi-megabyte
  // values). If the previous tick is still running, this one must no-op rather
  // than run a second cursor walk over the same rows.
  let sweeping = false;

  async function runSweep(): Promise<HeartbeatResultRetentionResult> {
    let examined = 0;
    let trimmed = 0;
    let batches = 0;
    const result: HeartbeatResultRetentionResult = {
      skipped: false,
      examined: 0,
      trimmed: 0,
      batches: 0,
      get residue() {
        return this.examined - this.trimmed;
      },
    };

    if (sweeping) {
      result.skipped = true;
      result.reason = "already_running";
      log.info({}, "heartbeat result retention: sweep already in progress; skipping this tick");
      return result;
    }

    sweeping = true;
    try {
      const cutoff = new Date(deps.now().getTime() - deps.config.retentionDays * MS_PER_DAY);
      // Forward-only cursor. Rows that are oversized for a reason this sweeper
      // cannot fix (a large field that is neither stdout nor stderr) stay
      // oversized, so a plain `LIMIT` would re-select the same page forever.
      // Ordering by (created_at, id) and walking past the last row seen
      // guarantees progress without needing a marker column or a `->>`
      // predicate. Such rows are simply re-examined on the next sweep.
      //
      // The timestamp is carried as opaque text, never a `Date` — see
      // `selectOversizedPage` below for why a millisecond round-trip turns this
      // into an infinite loop.
      let cursor: { createdAtText: string; id: string } | null = null;

      while (batches < deps.config.itemLimit) {
        const page = await deps.db.selectOversizedPage({
          cutoff,
          maxBytes: deps.config.maxBytes,
          limit: deps.config.batchSize,
          cursor,
        });
        if (page.length === 0) break;

        examined += page.length;
        const last = page[page.length - 1]!;
        cursor = { createdAtText: last.createdAtText, id: last.id };

        trimmed += await deps.db.trimResultJson({
          ids: page.map((row) => row.id),
          keepOutputChars: deps.config.keepOutputChars,
          maxBytes: deps.config.maxBytes,
        });
        batches += 1;
      }

      result.examined = examined;
      result.trimmed = trimmed;
      result.batches = batches;

      if (examined > 0) {
        log.info(
          {
            examined,
            trimmed,
            residue: examined - trimmed,
            batches,
            retentionDays: deps.config.retentionDays,
            cutoff: cutoff.toISOString(),
          },
          "heartbeat result retention: sweep complete",
        );
      }
      return result;
    } finally {
      sweeping = false;
    }
  }

  return { runSweep };
}

type Db = {
  execute: (query: unknown) => Promise<unknown>;
};

function readRows(raw: unknown): Array<Record<string, unknown>> {
  // The pg driver used here resolves `execute` to the rows array directly;
  // other drivers hand back a QueryResult. Accept both.
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  const rows = (raw as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

/**
 * `ARRAY[$1, $2, ...]::uuid[]`, matching the `sqlUuidArray` idiom in
 * company-search. Interpolating a bare JS array here would NOT produce an array
 * parameter — drizzle expands arrays into a `($1, $2, ...)` row constructor, so
 * `${ids}::uuid[]` casts a row to uuid[] and errors.
 */
function sqlUuidArray(values: string[]) {
  if (values.length === 0) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::uuid[]`;
}

export function createDrizzleHeartbeatResultRetentionDb(db: Db): HeartbeatResultRetentionDb {
  return {
    async selectOversizedPage({ cutoff, maxBytes, limit, cursor }) {
      // THE CURSOR TIMESTAMP MUST NOT PASS THROUGH A JS `Date`.
      //
      // `created_at` is `defaultNow()`, so stored values carry MICROSECONDS
      // (measured on production: 1997 of 2000 recent rows have a non-zero
      // sub-millisecond component). A `Date` holds milliseconds, and
      // `toISOString()` truncates rather than rounds, so a round-tripped cursor
      // is always slightly EARLIER than the row it came from. Row comparison
      // settles on the first element, so `(created_at, id) > (truncated, id)`
      // is true for that very row: it comes back at the head of the next page,
      // every page, and the loop — which only stops on an empty page — never
      // terminates once the newest remaining candidate is residue.
      //
      // So the timestamp is carried as Postgres' own text form and handed
      // straight back. It is an opaque token, never parsed on this side.
      const afterCursor = cursor
        ? sql`and (created_at, id) > (${cursor.createdAtText}::timestamptz, ${cursor.id}::uuid)`
        : sql``;
      const raw = await db.execute(sql`
        select id, created_at::text as created_at_text
        from ${heartbeatRuns}
        where created_at < ${cutoff.toISOString()}::timestamptz
          and result_json is not null
          and pg_column_size(result_json) > ${maxBytes}
          ${afterCursor}
        order by created_at, id
        limit ${limit}
      `);
      return readRows(raw).map((row) => ({
        id: String(row.id),
        createdAtText: String(row.created_at_text),
      }));
    },

    async trimResultJson({ ids, keepOutputChars, maxBytes }) {
      if (ids.length === 0) return 0;

      // Only rewrite a field when it is genuinely an over-long string. A `case`
      // yielding NULL combined with `jsonb_set_lax(..., 'return_target')` leaves
      // the document untouched for that field.
      //
      // `jsonb_set` (without `_lax`) is STRICT: a NULL new_value makes it return
      // NULL for the WHOLE document, which would wipe sessionId, cost and retry
      // bookkeeping — and self-conceal, because a nulled row stops matching
      // `result_json is not null`. The outer `coalesce(..., h.result_json)` is a
      // second belt for the same failure.
      const trimmedField = (field: "stdout" | "stderr") => sql`
        case
          when jsonb_typeof(h.result_json -> ${field}) = 'string'
            and length(h.result_json ->> ${field}) > ${keepOutputChars}
          then to_jsonb(left(h.result_json ->> ${field}, ${keepOutputChars}))
          else null
        end
      `;
      // `coalesce(..., false)`: an ABSENT key makes `jsonb_typeof` return NULL,
      // so the comparison is NULL rather than false. WHERE treats that as false
      // either way, but the stamped `stdoutTruncated` would otherwise read
      // `null` on a row that only had an over-long stderr. Keep it boolean.
      const isOverCap = (field: "stdout" | "stderr") => sql`
        coalesce(
          jsonb_typeof(h.result_json -> ${field}) = 'string'
            and length(h.result_json ->> ${field}) > ${keepOutputChars},
          false
        )
      `;
      // A producer may already have marked the output truncated before we ever
      // saw the row. Stamping our own finding on top would downgrade that
      // `true` to `false` and assert the output is complete when it is not, so
      // the two are OR'd. Compared as jsonb rather than cast to boolean: a
      // non-boolean value here would make a `::boolean` cast throw, while
      // jsonb equality just yields false.
      const wasAlreadyTruncated = (key: "stdoutTruncated" | "stderrTruncated") => sql`
        coalesce(h.result_json -> ${key} = 'true'::jsonb, false)
      `;

      const raw = await db.execute(sql`
        update ${heartbeatRuns} as h
        set result_json = coalesce(
              jsonb_set_lax(
                jsonb_set_lax(
                  h.result_json,
                  '{stdout}', ${trimmedField("stdout")}, false, 'return_target'
                ),
                '{stderr}', ${trimmedField("stderr")}, false, 'return_target'
              )
              || jsonb_build_object(
                   'truncated',          true,
                   'truncationReason',   'retention_trimmed',
                   -- The LOGICAL size, deliberately not pg_column_size. This
                   -- is the durable record of what was destroyed, and
                   -- pg_column_size reports the COMPRESSED stored size, which
                   -- can read an order of magnitude smaller than the text that
                   -- was actually there. (The API projection stamps the same
                   -- key from pg_column_size, but that value is ephemeral and
                   -- the row behind it is still intact.)
                   'originalSizeBytes',  octet_length(h.result_json::text),
                   'stdoutTruncated',    ${isOverCap("stdout")} or ${wasAlreadyTruncated("stdoutTruncated")},
                   'stderrTruncated',    ${isOverCap("stderr")} or ${wasAlreadyTruncated("stderrTruncated")},
                   'retentionTrimmedAt', now()
                 ),
              h.result_json
            ),
            -- Preserved on purpose: this is storage maintenance, not a change to
            -- the run. Bumping it would reorder every "recently updated" view
            -- and make months-old runs look freshly active.
            updated_at = h.updated_at
        where h.id = any(${sqlUuidArray(ids)})
          -- Re-checked here, not just in the selector: between the select and
          -- this update a concurrent writer could have replaced the document
          -- with a small one. Without this the sweeper would trim and stamp a
          -- row the API would have served whole.
          and pg_column_size(h.result_json) > ${maxBytes}
          and (${isOverCap("stdout")} or ${isOverCap("stderr")})
        returning h.id
      `);
      return readRows(raw).length;
    },
  };
}

export function createHeartbeatResultRetentionFromRuntime(
  db: Db,
  config: Config,
): HeartbeatResultRetention {
  return createHeartbeatResultRetention({
    db: createDrizzleHeartbeatResultRetentionDb(db),
    config: resolveHeartbeatResultRetentionConfig(config),
    now: () => new Date(),
  });
}
