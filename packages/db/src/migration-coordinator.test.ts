import { getEventListeners } from "node:events";
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

  it("fails if the session closes after the callback settles but before unlock completes", async () => {
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

  it("turns reserved backend termination into a controlled ownership failure", async () => {
    const url = database!.connectionString;
    const observer = (await import("postgres")).default(url, {
      max: 1,
      max_lifetime: null,
      prepare: false,
      onnotice: () => {},
    });
    const states: MigrationCoordinatorState[] = [];
    const coordinator = new MigrationCoordinator(url);

    try {
      const run = coordinator.withExclusiveMigrationLock(async () => {
        const rows = await observer.unsafe<{ pid: number }[]>(
          "SELECT pid::int AS pid FROM pg_locks WHERE locktype = 'advisory' AND granted",
        );
        expect(rows).toHaveLength(1);
        await observer.unsafe("SELECT pg_terminate_backend($1::int)", [String(rows[0]!.pid)]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "must-not-succeed";
      }, { onStateChange: (state) => states.push(state) });

      await expect(run).rejects.toThrow(/Lost ownership of migration lock/);
      expect(states).toEqual(["migrating", "failed"]);
    } finally {
      await observer.end();
    }
  });

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
