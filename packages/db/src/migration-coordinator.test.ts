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

  it("fails loudly when the reserved backend no longer owns the lock", async () => {
    const reserved = {
      unsafe: vi.fn()
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([{ unlocked: false }])
        .mockResolvedValueOnce([{ unlocked: false }]),
      release: vi.fn(),
    };
    const session = { reserve: vi.fn().mockResolvedValue(reserved), end: vi.fn() };
    const coordinator = new MigrationCoordinator("postgres://unused", undefined, (() => session) as never);

    await expect(coordinator.withExclusiveMigrationLock(async () => "done"))
      .rejects.toThrow(/Lost ownership of migration lock/);
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
