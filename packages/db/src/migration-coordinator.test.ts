import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";
import { MigrationCoordinator, type MigrationCoordinatorState } from "./migration-coordinator.js";

let database: EmbeddedPostgresTestDatabase | null = null;
const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const STRICT_SETTLEMENT_MS = 5_000;
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX_IMPORT = import.meta.resolve("tsx");

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function settleWithin<T>(promise: Promise<T>, timeoutMs = STRICT_SETTLEMENT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    ),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  return outcome;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorMessages(error: unknown): string[] {
  return error instanceof AggregateError
    ? [error.message, ...error.errors.flatMap(errorMessages)]
    : [errorMessage(error)];
}

async function waitForLockPid(sql: ReturnType<typeof postgres>): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await sql.unsafe<{ pid: number }[]>(
      "SELECT pid::int AS pid FROM pg_locks WHERE locktype = 'advisory' AND granted ORDER BY pid",
    );
    if (rows.length === 1) return rows[0]!.pid;
    await delay(5);
  }
  throw new Error("expected exactly one granted advisory lock");
}

async function terminateBackend(sql: ReturnType<typeof postgres>, pid: number): Promise<void> {
  const rows = await sql.unsafe<{ terminated: boolean }[]>(
    "SELECT pg_terminate_backend($1::int) AS terminated",
    [String(pid)],
  );
  expect(rows[0]?.terminated).toBe(true);
}

function createTrackedRealSessionFactory(
  scenario: "ordinary" | "during-unlock",
  onUnlockStarted?: () => void,
) {
  const tracked = { reserveCalls: 0, releaseCalls: 0, endCalls: 0 };
  const factory = (connectionString: string, options: Record<string, unknown>) => {
    const realSession = postgres(connectionString, options as never);
    return {
      reserve: async () => {
        tracked.reserveCalls += 1;
        const realConnection = await realSession.reserve();
        return {
          unsafe: (query: string, args: unknown[]) => {
            if (scenario === "during-unlock" && query.includes("pg_advisory_unlock")) {
              onUnlockStarted?.();
              return realConnection.unsafe(
                "SELECT pg_advisory_unlock($1::bigint) AS unlocked FROM (SELECT pg_sleep(1)) AS delayed",
                args as never,
              );
            }
            return realConnection.unsafe(query, args as never);
          },
          release: () => {
            tracked.releaseCalls += 1;
            realConnection.release();
          },
        };
      },
      end: async (options?: { timeout?: number }) => {
        tracked.endCalls += 1;
        await realSession.end(options);
      },
    };
  };
  return { factory, tracked };
}

async function expectControlledTermination(
  run: Promise<unknown>,
  states: MigrationCoordinatorState[],
): Promise<unknown> {
  const outcome = await settleWithin(run);
  expect(outcome.status).toBe("rejected");
  if (outcome.status !== "rejected") {
    throw new Error(`coordinator did not reject within ${STRICT_SETTLEMENT_MS}ms`);
  }
  expect(errorMessages(outcome.reason).join("\n")).toMatch(/Lost ownership of migration lock/);
  expect(states).toEqual(["migrating", "failed"]);
  expect(states.filter((state) => state === "failed")).toHaveLength(1);
  expect(states).not.toContain("ready");
  return outcome.reason;
}

async function expectNoLockAndSuccessfulTakeover(
  observer: ReturnType<typeof postgres>,
  connectionString: string,
): Promise<void> {
  const rows = await observer.unsafe<{ count: number }[]>(
    "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND granted",
  );
  expect(rows[0]?.count).toBe(0);
  const takeover = await new MigrationCoordinator(connectionString)
    .withExclusiveMigrationLock(async () => "takeover", { timeoutMs: 1_000, pollIntervalMs: 10 });
  expect(takeover.value).toBe("takeover");
}

describePostgres("MigrationCoordinator", () => {
  beforeAll(async () => {
    database = externalTestDatabaseUrl
      ? { connectionString: externalTestDatabaseUrl, cleanup: async () => {} }
      : await startEmbeddedPostgresTestDatabase("paperclip-migration-coordinator-");
  }, 120_000);

  afterAll(async () => {
    await database?.cleanup();
  }, 10_000);

  it("serializes holders and reports that a waiter re-acquired the lock", async () => {
    const url = database!.connectionString;
    const first = new MigrationCoordinator(url);
    const second = new MigrationCoordinator(url);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const order: string[] = [];
    const states: MigrationCoordinatorState[] = [];

    const holder = first.withExclusiveMigrationLock(async () => {
      order.push("holder-enter");
      firstEntered();
      await firstGate;
      order.push("holder-exit");
    });
    await entered;

    const waiter = second.withExclusiveMigrationLock(async () => {
      order.push("waiter-enter");
      return "done";
    }, {
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      onStateChange: (state) => states.push(state),
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["holder-enter"]);
    releaseFirst();

    const [, waited] = await Promise.all([holder, waiter]);
    expect(order).toEqual(["holder-enter", "holder-exit", "waiter-enter"]);
    expect(waited.value).toBe("done");
    expect(waited.metadata.waited).toBe(true);
    expect(waited.metadata.waitMs).toBeGreaterThan(0);
    expect(states).toEqual(["waiting_for_migration_lock", "migrating", "ready"]);
  }, 15_000);

  it("releases the advisory lock when the holder fails", async () => {
    const url = database!.connectionString;
    const failing = new MigrationCoordinator(url);
    await expect(
      failing.withExclusiveMigrationLock(async () => {
        throw new Error("migration failed");
      }),
    ).rejects.toThrow("migration failed");

    const next = new MigrationCoordinator(url);
    const result = await next.withExclusiveMigrationLock(async () => "recovered", {
      timeoutMs: 1_000,
      pollIntervalMs: 10,
    });
    expect(result.value).toBe("recovered");
    expect(result.metadata.waited).toBe(false);
  });

  it("keeps one reserved backend for the full action and disables lifetime recycling", async () => {
    const unsafe = vi.fn()
      .mockResolvedValueOnce([{ acquired: true }])
      .mockResolvedValueOnce([{ unlocked: true }]);
    const release = vi.fn();
    const reserved = { unsafe, release };
    const reserve = vi.fn().mockResolvedValue(reserved);
    const end = vi.fn().mockResolvedValue(undefined);
    const createSession = vi.fn(() => ({ reserve, end }));
    const coordinator = new MigrationCoordinator("postgres://unused", undefined, createSession as never);

    await coordinator.withExclusiveMigrationLock(async () => {
      expect(release).not.toHaveBeenCalled();
    });

    expect(createSession).toHaveBeenCalledWith("postgres://unused", expect.objectContaining({
      max: 1,
      max_lifetime: null,
    }));
    expect(reserve).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("ends the session and emits failed when reserve fails", async () => {
    const primary = new Error("reserve failed");
    const states: MigrationCoordinatorState[] = [];
    const session = {
      reserve: vi.fn().mockRejectedValue(primary),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const coordinator = new MigrationCoordinator("postgres://unused", undefined, (() => session) as never);

    await expect(coordinator.withExclusiveMigrationLock(async () => undefined, {
      onStateChange: (state) => states.push(state),
    })).rejects.toBe(primary);

    expect(session.end).toHaveBeenCalledOnce();
    expect(states).toEqual(["failed"]);
  });

  it("releases and ends the session when an acquisition query fails", async () => {
    const primary = new Error("acquisition query failed");
    const reserved = {
      unsafe: vi.fn().mockRejectedValue(primary),
      release: vi.fn(),
    };
    const session = {
      reserve: vi.fn().mockResolvedValue(reserved),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const coordinator = new MigrationCoordinator("postgres://unused", undefined, (() => session) as never);

    await expect(coordinator.withExclusiveMigrationLock(async () => undefined)).rejects.toBe(primary);

    expect(reserved.release).toHaveBeenCalledOnce();
    expect(session.end).toHaveBeenCalledOnce();
  });

  it("fails loudly and cleans up when the reserved backend no longer owns the lock", async () => {
    const states: MigrationCoordinatorState[] = [];
    const reserved = {
      unsafe: vi.fn()
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([{ unlocked: false }]),
      release: vi.fn(),
    };
    const session = {
      reserve: vi.fn().mockResolvedValue(reserved),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const coordinator = new MigrationCoordinator("postgres://unused", undefined, (() => session) as never);

    await expect(coordinator.withExclusiveMigrationLock(async () => "done", {
      onStateChange: (state) => states.push(state),
    })).rejects.toThrow(/Lost ownership of migration lock/);

    expect(reserved.release).toHaveBeenCalledOnce();
    expect(session.end).toHaveBeenCalledOnce();
    expect(states).toEqual(["migrating", "failed"]);
  });

  it("reports release failure after a successful migration and unlock", async () => {
    const primary = new Error("release failed");
    const reserved = {
      unsafe: vi.fn()
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([{ unlocked: true }]),
      release: vi.fn(() => { throw primary; }),
    };
    const session = {
      reserve: vi.fn().mockResolvedValue(reserved),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const states: MigrationCoordinatorState[] = [];
    const coordinator = new MigrationCoordinator("postgres://unused", undefined, (() => session) as never);

    await expect(coordinator.withExclusiveMigrationLock(async () => "done", {
      onStateChange: (state) => states.push(state),
    })).rejects.toBe(primary);

    expect(session.end).toHaveBeenCalledOnce();
    expect(states).toEqual(["migrating", "failed"]);
  });

  it("preserves a callback failure that settles after session ownership is lost", async () => {
    const primary = new Error("migration callback failed");
    let closeSession!: () => void;
    let rejectAction!: (error: Error) => void;
    const action = new Promise<never>((_, reject) => {
      rejectAction = reject;
    });
    const reserved = {
      unsafe: vi.fn().mockResolvedValueOnce([{ acquired: true }]),
      release: vi.fn(),
    };
    const session = {
      reserve: vi.fn().mockResolvedValue(reserved),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const createSession = vi.fn((_url, options) => {
      closeSession = options.onclose;
      return session;
    });
    const states: MigrationCoordinatorState[] = [];
    const coordinator = new MigrationCoordinator("postgres://unused", undefined, createSession as never);

    const run = coordinator.withExclusiveMigrationLock(() => action, {
      onStateChange: (state) => states.push(state),
    });
    await vi.waitFor(() => expect(reserved.unsafe).toHaveBeenCalledOnce());
    closeSession();
    rejectAction(primary);

    let thrown: unknown;
    try {
      await run;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors[0]).toBe(primary);
    expect((thrown as AggregateError).errors[1]).toEqual(expect.objectContaining({
      message: expect.stringMatching(/Lost ownership of migration lock/),
    }));
    expect((thrown as AggregateError).cause).toBe(primary);
    expect(states).toEqual(["migrating", "failed"]);
  });

  it("forces bounded teardown if the session closes after the callback settles but before unlock completes", async () => {
    let closeSession!: () => void;
    let resolveUnlock!: (rows: { unlocked: boolean }[]) => void;
    const unlock = new Promise<{ unlocked: boolean }[]>((resolve) => {
      resolveUnlock = resolve;
    });
    const reserved = {
      unsafe: vi.fn()
        .mockResolvedValueOnce([{ acquired: true }])
        .mockReturnValueOnce(unlock),
      release: vi.fn(),
    };
    const session = {
      reserve: vi.fn().mockResolvedValue(reserved),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const createSession = vi.fn((_url, options) => {
      closeSession = options.onclose;
      return session;
    });
    const states: MigrationCoordinatorState[] = [];
    const coordinator = new MigrationCoordinator("postgres://unused", undefined, createSession as never);

    const run = coordinator.withExclusiveMigrationLock(async () => "done", {
      onStateChange: (state) => states.push(state),
    });
    await vi.waitFor(() => expect(reserved.unsafe).toHaveBeenCalledTimes(2));
    closeSession();
    resolveUnlock([{ unlocked: true }]);

    await expect(run).rejects.toThrow(/Lost ownership of migration lock/);
    expect(reserved.release).not.toHaveBeenCalled();
    expect(session.end).toHaveBeenCalledOnce();
    expect(session.end).toHaveBeenCalledWith({ timeout: 1 });
    expect(states).toEqual(["migrating", "failed"]);
  });

  it("preserves callback failure when unlock and teardown also fail", async () => {
    const primary = new Error("migration callback failed");
    const unlock = new Error("unlock failed");
    const end = new Error("session end failed");
    const reserved = {
      unsafe: vi.fn()
        .mockResolvedValueOnce([{ acquired: true }])
        .mockRejectedValueOnce(unlock),
      release: vi.fn(),
    };
    const session = {
      reserve: vi.fn().mockResolvedValue(reserved),
      end: vi.fn().mockRejectedValue(end),
    };
    const states: MigrationCoordinatorState[] = [];
    const coordinator = new MigrationCoordinator("postgres://unused", undefined, (() => session) as never);

    let thrown: unknown;
    try {
      await coordinator.withExclusiveMigrationLock(async () => { throw primary; }, {
        onStateChange: (state) => states.push(state),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([primary, unlock, end]);
    expect((thrown as AggregateError).cause).toBe(primary);
    expect(states).toEqual(["migrating", "failed"]);
    expect(reserved.release).toHaveBeenCalledOnce();
    expect(session.end).toHaveBeenCalledOnce();
  });

  it("emits failed rather than ready when required teardown fails", async () => {
    const reserved = {
      unsafe: vi.fn()
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([{ unlocked: true }]),
      release: vi.fn(),
    };
    const session = {
      reserve: vi.fn().mockResolvedValue(reserved),
      end: vi.fn().mockRejectedValue(new Error("session end failed")),
    };
    const states: MigrationCoordinatorState[] = [];
    const coordinator = new MigrationCoordinator("postgres://unused", undefined, (() => session) as never);

    await expect(coordinator.withExclusiveMigrationLock(async () => "done", {
      onStateChange: (state) => states.push(state),
    })).rejects.toThrow("session end failed");

    expect(states).toEqual(["migrating", "failed"]);
  });

  it("removes abort listeners after each successful polling sleep", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const reserved = {
      unsafe: vi.fn().mockImplementation(async () => {
        attempts += 1;
        return attempts === 20 ? [{ acquired: true }] : attempts === 21
          ? [{ unlocked: true }]
          : [{ acquired: false }];
      }),
      release: vi.fn(),
    };
    const session = { reserve: vi.fn().mockResolvedValue(reserved), end: vi.fn() };
    const coordinator = new MigrationCoordinator("postgres://unused", undefined, (() => session) as never);

    await coordinator.withExclusiveMigrationLock(async () => undefined, {
      signal: controller.signal,
      pollIntervalMs: 1,
    });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("cleans up and reports a failed late unlock", async () => {
    vi.useFakeTimers();
    try {
      let resolveQuery!: (rows: { acquired: boolean }[]) => void;
      const delayedQuery = new Promise<{ acquired: boolean }[]>((resolve) => {
        resolveQuery = resolve;
      }) as Promise<{ acquired: boolean }[]> & { cancel: () => void };
      delayedQuery.cancel = vi.fn();
      const reserved = {
        unsafe: vi.fn()
          .mockReturnValueOnce(delayedQuery)
          .mockResolvedValueOnce([{ unlocked: false }]),
        release: vi.fn(),
      };
      const session = { reserve: vi.fn().mockResolvedValue(reserved), end: vi.fn() };
      const cleanupErrors: unknown[] = [];
      const coordinator = new MigrationCoordinator("postgres://unused", undefined, (() => session) as never);

      const result = coordinator.withExclusiveMigrationLock(async () => undefined, {
        timeoutMs: 25,
        onCleanupError: (error) => cleanupErrors.push(error),
      });
      const rejected = expect(result).rejects.toThrow(/Timed out after 25ms/);
      await vi.advanceTimersByTimeAsync(25);
      resolveQuery([{ acquired: true }]);
      await vi.runAllTimersAsync();
      await rejected;

      expect(cleanupErrors).toHaveLength(1);
      expect(cleanupErrors[0]).toEqual(expect.objectContaining({
        message: expect.stringMatching(/Lost ownership of migration lock/),
      }));
      expect(reserved.release).toHaveBeenCalledOnce();
      expect(session.end).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects and releases a lock acquired after the absolute deadline", async () => {
    vi.useFakeTimers();
    try {
      let resolveQuery!: (rows: { acquired: boolean }[]) => void;
      const delayedQuery = new Promise<{ acquired: boolean }[]>((resolve) => {
        resolveQuery = resolve;
      }) as Promise<{ acquired: boolean }[]> & { cancel: () => void };
      delayedQuery.cancel = vi.fn();
      const reserved = {
        unsafe: vi.fn()
          .mockReturnValueOnce(delayedQuery)
          .mockResolvedValueOnce([{ unlocked: true }]),
        release: vi.fn(),
      };
      const session = { reserve: vi.fn().mockResolvedValue(reserved), end: vi.fn() };
      const coordinator = new MigrationCoordinator("postgres://unused", undefined, (() => session) as never);
      const action = vi.fn();

      const result = coordinator.withExclusiveMigrationLock(action, { timeoutMs: 25 });
      const rejected = expect(result).rejects.toThrow(/Timed out after 25ms/);
      await vi.advanceTimersByTimeAsync(25);
      resolveQuery([{ acquired: true }]);
      await vi.runAllTimersAsync();

      await rejected;
      expect(action).not.toHaveBeenCalled();
      expect(reserved.unsafe).toHaveBeenCalledWith(
        "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
        expect.any(Array),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels acquisition and rejects when aborted", async () => {
    const query = new Promise<never>(() => {}) as Promise<never> & { cancel: () => void };
    query.cancel = vi.fn();
    const reserved = { unsafe: vi.fn().mockReturnValue(query), release: vi.fn() };
    const session = { reserve: vi.fn().mockResolvedValue(reserved), end: vi.fn() };
    const coordinator = new MigrationCoordinator("postgres://unused", undefined, (() => session) as never);
    const controller = new AbortController();
    const result = coordinator.withExclusiveMigrationLock(async () => undefined, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(reserved.unsafe).toHaveBeenCalledOnce());

    controller.abort(new Error("shutdown"));

    await expect(result).rejects.toThrow("shutdown");
    expect(query.cancel).toHaveBeenCalledOnce();
    expect(reserved.release).not.toHaveBeenCalled();
    expect(session.end).not.toHaveBeenCalled();
  });

  it("settles as failed when the reserved backend terminates during the callback", async () => {
    const url = database!.connectionString;
    const observer = postgres(url, { max: 1, max_lifetime: null, prepare: false, onnotice: () => {} });
    const worker = postgres(url, { max: 1, max_lifetime: null, prepare: false, onnotice: () => {} });
    const { factory, tracked } = createTrackedRealSessionFactory("ordinary");
    const states: MigrationCoordinatorState[] = [];
    let entered!: () => void;
    let continueAction!: () => void;
    const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
    const callbackGate = new Promise<void>((resolve) => { continueAction = resolve; });
    const coordinator = new MigrationCoordinator(url, undefined, factory as never);

    try {
      const run = coordinator.withExclusiveMigrationLock(async () => {
        entered();
        await callbackGate;
        await worker.unsafe(
          "CREATE TABLE IF NOT EXISTS migration_lock_loss_residual (id integer primary key)",
        );
        return "must-not-succeed";
      }, { onStateChange: (state) => states.push(state) });
      await callbackEntered;
      await terminateBackend(observer, await waitForLockPid(observer));
      continueAction();

      await expectControlledTermination(run, states);
      const residual = await observer.unsafe<{ exists: boolean }[]>(
        "SELECT to_regclass('public.migration_lock_loss_residual') IS NOT NULL AS exists",
      );
      expect(residual[0]?.exists).toBe(true);
      expect(tracked).toMatchObject({ reserveCalls: 1, endCalls: 1 });
      expect(tracked.releaseCalls).toBeLessThanOrEqual(1);
      await expectNoLockAndSuccessfulTakeover(observer, url);
    } finally {
      await Promise.allSettled([observer.end({ timeout: 1 }), worker.end({ timeout: 1 })]);
    }
  }, 15_000);

  it("settles as failed when the reserved backend terminates immediately after callback settlement", async () => {
    const url = database!.connectionString;
    const observer = postgres(url, { max: 1, max_lifetime: null, prepare: false, onnotice: () => {} });
    const { factory, tracked } = createTrackedRealSessionFactory("ordinary");
    const states: MigrationCoordinatorState[] = [];
    const coordinator = new MigrationCoordinator(url, undefined, factory as never);

    try {
      const run = coordinator.withExclusiveMigrationLock(async () => {
        await terminateBackend(observer, await waitForLockPid(observer));
        return "must-not-succeed";
      }, { onStateChange: (state) => states.push(state) });

      await expectControlledTermination(run, states);
      expect(tracked).toMatchObject({ reserveCalls: 1, endCalls: 1 });
      expect(tracked.releaseCalls).toBeLessThanOrEqual(1);
      await expectNoLockAndSuccessfulTakeover(observer, url);
    } finally {
      await observer.end({ timeout: 1 });
    }
  }, 15_000);

  it("settles as failed when the reserved backend terminates during unlock", async () => {
    const url = database!.connectionString;
    const observer = postgres(url, { max: 1, max_lifetime: null, prepare: false, onnotice: () => {} });
    let unlockStarted!: () => void;
    const unlockInFlight = new Promise<void>((resolve) => { unlockStarted = resolve; });
    const { factory, tracked } = createTrackedRealSessionFactory("during-unlock", unlockStarted);
    const states: MigrationCoordinatorState[] = [];
    const coordinator = new MigrationCoordinator(url, undefined, factory as never);

    try {
      const run = coordinator.withExclusiveMigrationLock(async () => "must-not-succeed", {
        onStateChange: (state) => states.push(state),
      });
      await unlockInFlight;
      const pid = await waitForLockPid(observer);
      await delay(50);
      await terminateBackend(observer, pid);

      await expectControlledTermination(run, states);
      expect(tracked).toMatchObject({ reserveCalls: 1, endCalls: 1 });
      expect(tracked.releaseCalls).toBeLessThanOrEqual(1);
      await expectNoLockAndSuccessfulTakeover(observer, url);
    } finally {
      await observer.end({ timeout: 1 });
    }
  }, 15_000);

  it.each([
    { key: "DATABASE_URL", value: "", label: "empty" },
    { key: "DATABASE_URL", value: "  \t  ", label: "whitespace" },
    { key: "DATABASE_MIGRATION_URL", value: "", label: "empty" },
    { key: "DATABASE_MIGRATION_URL", value: "  \t  ", label: "whitespace" },
  ] as const)(
    "actual server and db:migrate entrypoints fail closed for $label process $key",
    async ({ key, value }) => {
      const url = database!.connectionString;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-entrypoint-config-"));
      const cwd = path.join(root, "cwd");
      const instance = path.join(root, "instance");
      const configPath = path.join(instance, "config.json");
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(instance, { recursive: true });
      fs.writeFileSync(
        path.join(instance, ".env"),
        "PAPERCLIP_DEPLOYMENT_PROFILE=multi_replica\n" +
          `DATABASE_URL=${url}\n` +
          `DATABASE_MIGRATION_URL=${url}\n` +
          "DATABASE_MIGRATION_SESSION_CAPABLE=true\n" +
          "PAPERCLIP_MIGRATION_LOCK_TIMEOUT_MS=30000\n",
      );
      const observer = postgres(url, { max: 1, max_lifetime: null, prepare: false, onnotice: () => {} });

      try {
        const before = await observer.unsafe<{ count: number }[]>(
          "SELECT count(*)::int AS count FROM pg_class WHERE relname = '__drizzle_migrations'",
        );
        const env = { ...process.env };
        for (const envKey of [
          "PAPERCLIP_DEPLOYMENT_PROFILE",
          "DATABASE_URL",
          "DATABASE_MIGRATION_URL",
          "DATABASE_MIGRATION_SESSION_CAPABLE",
          "PAPERCLIP_MIGRATION_LOCK_TIMEOUT_MS",
        ]) delete env[envKey];
        Object.assign(env, {
          PAPERCLIP_CONFIG: configPath,
          PAPERCLIP_HOME: path.join(root, "home"),
          PAPERCLIP_DECISION_SIGNING_SECRET: "entrypoint-test-signing-secret-value",
          [key]: value,
        });

        for (const entrypoint of [
          path.join(REPO_ROOT, "server", "src", "index.ts"),
          path.join(REPO_ROOT, "packages", "db", "src", "migrate.ts"),
        ]) {
          const child = spawnSync(process.execPath, ["--import", TSX_IMPORT, entrypoint], {
            cwd,
            env,
            encoding: "utf8",
            timeout: 30_000,
          });
          expect(child.error).toBeUndefined();
          expect(child.status).toBe(1);
          const output = `${child.stdout}\n${child.stderr}`;
          expect(output).toContain(`${key} must not be blank when defined`);
          expect(output).not.toContain(url);
        }

        const after = await observer.unsafe<{ count: number }[]>(
          "SELECT count(*)::int AS count FROM pg_class WHERE relname = '__drizzle_migrations'",
        );
        expect(after[0]?.count).toBe(before[0]?.count);
      } finally {
        await observer.end({ timeout: 1 });
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it("times out a waiter without releasing another session's lock", async () => {
    const url = database!.connectionString;
    const holder = new MigrationCoordinator(url);
    const waiter = new MigrationCoordinator(url);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const holderEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const held = holder.withExclusiveMigrationLock(async () => {
      entered();
      await gate;
    });
    await holderEntered;

    await expect(
      waiter.withExclusiveMigrationLock(async () => undefined, {
        timeoutMs: 50,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow(/Timed out after 50ms waiting for migration lock [0-9a-f]{12}/);

    release();
    await held;
  });
});
