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
  onCleanupError?: (error: unknown) => void;
  signal?: AbortSignal;
}

type MigrationSession = ReturnType<typeof postgres>;
type MigrationConnection = Awaited<ReturnType<MigrationSession["reserve"]>>;
type MigrationSessionFactory = (
  connectionString: string,
  options: {
    max: 1;
    max_lifetime: null;
    prepare: false;
    onnotice: () => void;
    onclose: () => void;
  },
) => MigrationSession;

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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (result: "resolve" | "reject") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (result === "resolve") resolve();
      else reject(signal?.reason ?? new Error("Migration lock acquisition aborted"));
    };
    const timer = setTimeout(() => settle("resolve"), ms);
    const abort = () => settle("reject");
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function combineErrors(primary: unknown, cleanupErrors: unknown[]): unknown {
  if (primary === undefined) {
    if (cleanupErrors.length === 0) return undefined;
    if (cleanupErrors.length === 1) return cleanupErrors[0];
    return new AggregateError(cleanupErrors, "Migration coordinator cleanup failed");
  }
  if (cleanupErrors.length === 0) return primary;
  const message = primary instanceof Error ? primary.message : "Migration failed";
  return new AggregateError([primary, ...cleanupErrors], message, { cause: primary });
}

export class MigrationCoordinator {
  readonly lockId: string;
  private readonly lockKey: bigint;
  private readonly createSession: MigrationSessionFactory;

  constructor(
    private readonly connectionString: string,
    lockName = DEFAULT_MIGRATION_LOCK_NAME,
    createSession: MigrationSessionFactory = postgres,
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
    const deadline = startedAt + timeoutMs;
    let sessionClosed = false;
    let closingSession = false;
    let notifySessionLoss!: () => void;
    const sessionLost = new Promise<void>((resolve) => {
      notifySessionLoss = resolve;
    });
    const ownershipError = () => new Error(`Lost ownership of migration lock ${this.lockId}`);
    const sql = this.createSession(this.connectionString, {
      max: 1,
      max_lifetime: null,
      prepare: false,
      onnotice: () => {},
      onclose: () => {
        if (closingSession || sessionClosed) return;
        sessionClosed = true;
        notifySessionLoss();
      },
    });
    let connection: MigrationConnection | undefined;
    let acquired = false;
    let waited = false;
    let cleanupDeferred = false;
    let cleaned = false;

    const setState = (state: MigrationCoordinatorState) => options.onStateChange?.(state);
    const reportCleanupError = (error: unknown) => options.onCleanupError?.(error);
    const timeoutError = () =>
      new Error(`Timed out after ${timeoutMs}ms waiting for migration lock ${this.lockId}`);
    const assertWithinDeadline = () => {
      if (Date.now() >= deadline) throw timeoutError();
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("Migration lock acquisition aborted");
      }
      if (sessionClosed) throw ownershipError();
    };
    const cleanup = async (unlockHeld: boolean): Promise<unknown[]> => {
      if (cleaned) return [];
      cleaned = true;
      const errors: unknown[] = [];
      if (unlockHeld && sessionClosed) {
        errors.push(ownershipError());
      } else if (unlockHeld && connection) {
        let unlockFailed = false;
        try {
          await this.unlock(connection, () => sessionClosed);
        } catch (error) {
          unlockFailed = true;
          errors.push(error);
        }
        if (sessionClosed && !unlockFailed) errors.push(ownershipError());
      }
      if (!sessionClosed) {
        try {
          connection?.release();
        } catch (error) {
          errors.push(error);
        }
      }
      closingSession = true;
      try {
        await sql.end();
      } catch (error) {
        errors.push(error);
      }
      return errors;
    };

    let value: T | undefined;
    let waitMs = 0;
    let primaryError: unknown;

    try {
      assertWithinDeadline();
      connection = await this.beforeDeadline(
        sql.reserve(),
        deadline,
        timeoutError,
        async (lateConnection) => {
          const errors: unknown[] = [];
          try {
            lateConnection.release();
          } catch (error) {
            errors.push(error);
          }
          closingSession = true;
          try {
            await sql.end();
          } catch (error) {
            errors.push(error);
          }
          errors.forEach(reportCleanupError);
        },
        options.signal,
        () => {
          cleanupDeferred = true;
        },
        async () => {
          closingSession = true;
          try {
            await sql.end();
          } catch (error) {
            reportCleanupError(error);
          }
        },
      );

      while (!acquired) {
        assertWithinDeadline();
        const query = connection.unsafe<{ acquired: boolean }[]>(
          "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
          [this.lockKey.toString()],
        );
        const finishLateQuery = async () => {
          const errors = await cleanup(false);
          errors.forEach(reportCleanupError);
        };
        const rows = await this.beforeDeadline(
          query,
          deadline,
          timeoutError,
          async (lateRows) => {
            try {
              if (lateRows[0]?.acquired === true) {
                await this.unlock(connection!, () => sessionClosed);
              }
            } catch (error) {
              reportCleanupError(error);
            } finally {
              await finishLateQuery();
            }
          },
          options.signal,
          () => {
            cleanupDeferred = true;
            query.cancel();
          },
          finishLateQuery,
        );
        acquired = rows[0]?.acquired === true;
        assertWithinDeadline();
        if (acquired) break;

        if (!waited) {
          waited = true;
          setState("waiting_for_migration_lock");
        }
        await sleep(Math.min(pollIntervalMs, deadline - Date.now()), options.signal);
      }

      waitMs = Date.now() - startedAt;
      setState("migrating");
      const actionPromise = action();
      const ownershipLost = await Promise.race([
        actionPromise.then(() => false, () => false),
        sessionLost.then(() => true),
      ]);
      if (ownershipLost) {
        acquired = false;
        try {
          await actionPromise;
        } catch (error) {
          throw combineErrors(error, [ownershipError()]);
        }
        throw ownershipError();
      }
      value = await actionPromise;
    } catch (error) {
      primaryError = error;
    }

    const cleanupErrors = cleanupDeferred ? [] : await cleanup(acquired);
    const error = combineErrors(primaryError, cleanupErrors);
    if (error !== undefined) {
      setState("failed");
      throw error;
    }

    const durationMs = Date.now() - startedAt;
    setState("ready");
    return {
      value: value as T,
      metadata: {
        lockId: this.lockId,
        waited,
        waitMs,
        durationMs,
        state: "ready",
      },
    };
  }

  private async unlock(connection: MigrationConnection, isClosed = () => false): Promise<void> {
    if (isClosed()) throw new Error(`Lost ownership of migration lock ${this.lockId}`);
    const rows = await connection.unsafe<{ unlocked: boolean }[]>(
      "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
      [this.lockKey.toString()],
    );
    if (rows[0]?.unlocked !== true) {
      throw new Error(`Lost ownership of migration lock ${this.lockId}`);
    }
  }

  private async beforeDeadline<T>(
    operation: PromiseLike<T>,
    deadline: number,
    timeoutError: () => Error,
    onLate: (value: T) => void | Promise<void>,
    signal?: AbortSignal,
    cancel?: () => void,
    onRejectedLate?: () => void | Promise<void>,
  ): Promise<T> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError();

    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const operationPromise = Promise.resolve(operation);
    const boundary = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cancel?.();
        operationPromise.then(onLate, onRejectedLate).catch(() => {});
        reject(timeoutError());
      }, remainingMs);
      abort = () => {
        cancel?.();
        operationPromise.then(onLate, onRejectedLate).catch(() => {});
        reject(signal?.reason ?? new Error("Migration lock acquisition aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });

    try {
      return await Promise.race([operationPromise, boundary]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
}
