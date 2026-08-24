import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
