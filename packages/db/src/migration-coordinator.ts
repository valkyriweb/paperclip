import { createHash } from "node:crypto";
import postgres from "postgres";

const DEFAULT_MIGRATION_LOCK_NAME = "paperclip:database-migrations:v1";
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MIGRATION_LOCK_POLL_MS = 250;

export type MigrationCoordinatorState =
  | "waiting_for_migration_lock"
  | "migrating"
  | "ready"
  | "failed";

export interface MigrationLockMetadata {
  lockId: string;
  waited: boolean;
  waitMs: number;
  durationMs: number;
  state: MigrationCoordinatorState;
}

export interface MigrationCoordinatorOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  onStateChange?: (state: MigrationCoordinatorState) => void;
}

type MigrationSession = ReturnType<typeof postgres>;
type MigrationSessionFactory = (connectionString: string) => MigrationSession;

function migrationLockKey(name: string): bigint {
  const bytes = createHash("sha256").update(name).digest().subarray(0, 8);
  return bytes.readBigInt64BE(0);
}

function migrationLockId(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 12);
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MigrationCoordinator {
  readonly lockId: string;
  private readonly lockKey: bigint;
  private readonly createSession: MigrationSessionFactory;

  constructor(
    private readonly connectionString: string,
    lockName = DEFAULT_MIGRATION_LOCK_NAME,
    createSession: MigrationSessionFactory = (url) => postgres(url, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    }),
  ) {
    this.lockKey = migrationLockKey(lockName);
    this.lockId = migrationLockId(lockName);
    this.createSession = createSession;
  }

  async withExclusiveMigrationLock<T>(
    action: () => Promise<T>,
    options: MigrationCoordinatorOptions = {},
  ): Promise<{ value: T; metadata: MigrationLockMetadata }> {
    const timeoutMs = positiveInteger(
      options.timeoutMs,
      DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
      "migration lock timeout",
    );
    const pollIntervalMs = positiveInteger(
      options.pollIntervalMs,
      DEFAULT_MIGRATION_LOCK_POLL_MS,
      "migration lock poll interval",
    );
    const startedAt = Date.now();
    const sql = this.createSession(this.connectionString);
    let acquired = false;
    let waited = false;

    const setState = (state: MigrationCoordinatorState) => options.onStateChange?.(state);

    try {
      while (!acquired) {
        const rows = await sql.unsafe<{ acquired: boolean }[]>(
          "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
          [this.lockKey.toString()],
        );
        acquired = rows[0]?.acquired === true;
        if (acquired) break;

        if (!waited) {
          waited = true;
          setState("waiting_for_migration_lock");
        }
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(
            `Timed out after ${timeoutMs}ms waiting for migration lock ${this.lockId}`,
          );
        }
        await sleep(Math.min(pollIntervalMs, timeoutMs - (Date.now() - startedAt)));
      }

      const waitMs = Date.now() - startedAt;
      setState("migrating");
      const value = await action();
      const durationMs = Date.now() - startedAt;
      setState("ready");
      return {
        value,
        metadata: {
          lockId: this.lockId,
          waited,
          waitMs,
          durationMs,
          state: "ready",
        },
      };
    } catch (error) {
      setState("failed");
      throw error;
    } finally {
      if (acquired) {
        try {
          await sql.unsafe(
            "SELECT pg_advisory_unlock($1::bigint)",
            [this.lockKey.toString()],
          );
        } finally {
          await sql.end();
        }
      } else {
        await sql.end();
      }
    }
  }
}
