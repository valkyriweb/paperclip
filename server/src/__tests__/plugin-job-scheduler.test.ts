/**
 * Tests for PluginJobScheduler covering the active-active reforge slice 004
 * remediation cycle:
 *
 * - B3: `registerPlugin`'s `nextRunAt` bootstrap must never touch a job that
 *   already has a pointer (overdue or not), and must never clobber
 *   `lastRunAt`.
 * - B1: a rejected `renewOccurrenceLease`/`completeOccurrence` promise
 *   inside `executeClaimedRun` (a fire-and-forget path, invoked via
 *   `void executeClaimedRun(...)`) must never surface as an unhandled
 *   promise rejection.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, pluginJobOccurrences, pluginJobs, plugins } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { createPluginJobScheduler, type PluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import * as claimsStore from "../services/plugin-job-claims-store.js";
import { DEFAULT_OCCURRENCE_LEASE_TTL_MS } from "../services/plugin-job-claims-store.js";

vi.mock("../services/plugin-job-claims-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/plugin-job-claims-store.js")>();
  return {
    ...actual,
    // Wrapped (not replaced) so the default behavior is the real
    // implementation — individual tests use mockRejectedValueOnce /
    // mockImplementationOnce to inject a single failure, then the wrapper
    // falls back to the real behavior again automatically.
    renewOccurrenceLease: vi.fn(actual.renewOccurrenceLease),
    completeOccurrence: vi.fn(actual.completeOccurrence),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("plugin job scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let jobStore: ReturnType<typeof pluginJobStore>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-job-scheduler-");
    db = createDb(tempDb.connectionString);
    jobStore = pluginJobStore(db);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let unhandledRejections: unknown[] = [];
  function onUnhandledRejection(reason: unknown) {
    unhandledRejections.push(reason);
  }

  beforeEach(() => {
    unhandledRejections = [];
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    vi.useRealTimers();
    vi.mocked(claimsStore.renewOccurrenceLease).mockClear();
    vi.mocked(claimsStore.completeOccurrence).mockClear();
  });

  async function seedPlugin() {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `test-plugin-${pluginId.slice(0, 8)}`,
      packageName: "test-plugin",
      version: "1.0.0",
      manifestJson: { id: "test-plugin", name: "Test Plugin", version: "1.0.0" } as never,
    });
    return pluginId;
  }

  async function seedJob(input: { pluginId: string; nextRunAt?: Date | null; lastRunAt?: Date | null }) {
    const jobId = randomUUID();
    await db.insert(pluginJobs).values({
      id: jobId,
      pluginId: input.pluginId,
      jobKey: `job-${jobId.slice(0, 8)}`,
      schedule: "* * * * *",
      status: "active",
      nextRunAt: input.nextRunAt === undefined ? new Date() : input.nextRunAt,
      lastRunAt: input.lastRunAt ?? null,
    });
    return jobId;
  }

  async function cleanup(pluginId: string) {
    await db.delete(pluginJobOccurrences).where(eq(pluginJobOccurrences.pluginId, pluginId));
    await db.delete(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
    await db.delete(plugins).where(eq(plugins.id, pluginId));
  }

  function makeScheduler(workerCall: ReturnType<typeof vi.fn>): PluginJobScheduler {
    const workerManager = {
      isRunning: vi.fn().mockReturnValue(true),
      call: workerCall,
    } as unknown as PluginWorkerManager;
    return createPluginJobScheduler({ db, jobStore, workerManager });
  }

  // -------------------------------------------------------------------------
  // B3: ensureNextRunTimestamps bootstrap-only-when-null
  // -------------------------------------------------------------------------

  it("registerPlugin bootstraps nextRunAt only for a job that has never had one", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedJob({ pluginId, nextRunAt: null });
    const scheduler = makeScheduler(vi.fn());

    try {
      await scheduler.registerPlugin(pluginId);

      const [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.id, jobId));
      expect(job!.nextRunAt).not.toBeNull();
    } finally {
      await cleanup(pluginId);
    }
  });

  it("registerPlugin does NOT advance an overdue nextRunAt or clobber lastRunAt (B3 negative control)", async () => {
    const pluginId = await seedPlugin();
    const overdueNextRunAt = new Date(Date.now() - 10 * 60_000); // 10 minutes overdue
    const realLastRunAt = new Date(Date.now() - 20 * 60_000);
    const jobId = await seedJob({ pluginId, nextRunAt: overdueNextRunAt, lastRunAt: realLastRunAt });
    const scheduler = makeScheduler(vi.fn());

    try {
      await scheduler.registerPlugin(pluginId);

      const [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.id, jobId));
      // Must be untouched — claimDueOccurrences is the only path allowed to
      // advance the pointer, and only that path may also update lastRunAt.
      expect(job!.nextRunAt!.getTime()).toBe(overdueNextRunAt.getTime());
      expect(job!.lastRunAt!.getTime()).toBe(realLastRunAt.getTime());
    } finally {
      await cleanup(pluginId);
    }
  });

  it("registerPlugin leaves a future (not-yet-due) nextRunAt untouched", async () => {
    const pluginId = await seedPlugin();
    const futureNextRunAt = new Date(Date.now() + 10 * 60_000);
    const jobId = await seedJob({ pluginId, nextRunAt: futureNextRunAt });
    const scheduler = makeScheduler(vi.fn());

    try {
      await scheduler.registerPlugin(pluginId);

      const [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.id, jobId));
      expect(job!.nextRunAt!.getTime()).toBe(futureNextRunAt.getTime());
    } finally {
      await cleanup(pluginId);
    }
  });

  // -------------------------------------------------------------------------
  // B1: rejected renew/complete promises inside executeClaimedRun's
  // fire-and-forget path must never become unhandled rejections.
  // -------------------------------------------------------------------------

  it("a rejected renewOccurrenceLease during an in-flight dispatch never becomes an unhandled rejection (B1)", async () => {
    // Only fake setInterval/clearInterval — the lease-renewal interval is
    // Math.max(5_000, floor(DEFAULT_OCCURRENCE_LEASE_TTL_MS / 3)) (=60s), too
    // slow to wait out in real time, but the DB calls it triggers are real
    // I/O and must keep resolving on the real clock, so setTimeout/Date/etc.
    // stay real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pluginId = await seedPlugin();
    const jobId = await seedJob({ pluginId });

    const rpc = deferred<void>();
    const workerCall = vi.fn().mockReturnValue(rpc.promise);
    const scheduler = makeScheduler(workerCall);

    async function realWait(ms: number) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function waitForCall(mock: ReturnType<typeof vi.fn>, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (mock.mock.calls.length === 0 && Date.now() < deadline) {
        await realWait(20);
      }
      expect(mock.mock.calls.length).toBeGreaterThan(0);
    }

    try {
      vi.mocked(claimsStore.renewOccurrenceLease).mockRejectedValueOnce(new Error("simulated DB error"));

      const { runId } = await scheduler.triggerJob(jobId);
      expect(runId).toBeTruthy();

      // Let executeClaimedRun's real DB awaits (markRunning, acknowledge)
      // settle and startLeaseRenewal register its (faked) interval.
      await realWait(100);

      // Fire the lease-renewal interval once — its rejected promise must be
      // caught internally, not thrown out of the setInterval callback.
      // Interval is Math.max(5_000, floor(leaseTtl/3)); with the 180s TTL that
      // is 60s (not the old 30s from the 90s TTL era).
      await vi.advanceTimersByTimeAsync(
        Math.max(5_000, Math.floor(DEFAULT_OCCURRENCE_LEASE_TTL_MS / 3)),
      );
      await waitForCall(vi.mocked(claimsStore.renewOccurrenceLease));

      expect(unhandledRejections).toHaveLength(0);

      // Resolve the in-flight RPC so the job completes and the interval is
      // cleared.
      rpc.resolve(undefined);
      await realWait(100);

      expect(unhandledRejections).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await cleanup(pluginId);
    }
  }, 15_000);

  it("a rejected completeOccurrence after a successful run never becomes an unhandled rejection (B1)", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedJob({ pluginId });

    const rpc = deferred<void>();
    const workerCall = vi.fn().mockReturnValue(rpc.promise);
    const scheduler = makeScheduler(workerCall);

    try {
      vi.mocked(claimsStore.completeOccurrence).mockRejectedValueOnce(new Error("simulated DB error on complete"));

      const { runId, jobId: triggeredJobId } = await scheduler.triggerJob(jobId);
      expect(runId).toBeTruthy();
      expect(triggeredJobId).toBe(jobId);

      rpc.resolve(undefined);

      // executeClaimedRun runs detached (void); poll for completeOccurrence
      // to have been attempted rather than assuming a fixed delay.
      await vi.waitFor(() => {
        expect(vi.mocked(claimsStore.completeOccurrence)).toHaveBeenCalled();
      });

      // Give the swallow-and-log catch block a turn to finish.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(unhandledRejections).toHaveLength(0);

      // safeCompleteOccurrence swallowed the throw and returned null without
      // persisting a "succeeded" resolution — the occurrence is left exactly
      // where acknowledgeOccurrence put it (status "running"), not silently
      // marked complete.
      const [occurrence] = await db
        .select()
        .from(pluginJobOccurrences)
        .where(eq(pluginJobOccurrences.jobId, jobId));
      expect(occurrence!.status).toBe("running");
    } finally {
      await cleanup(pluginId);
    }
  }, 15_000);
});
