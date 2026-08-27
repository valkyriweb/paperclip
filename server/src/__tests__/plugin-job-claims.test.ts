import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, pluginJobOccurrences, pluginJobRuns, pluginJobs, plugins } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  acknowledgeOccurrence,
  claimDueOccurrences,
  claimManualOccurrence,
  completeOccurrence,
  findExpiredOccurrences,
  isOccurrenceClaimStale,
  renewOccurrenceLease,
  revokeUnacknowledgedOccurrences,
  takeoverExpiredOccurrence,
  type OccurrenceClaim,
} from "../services/plugin-job-claims-store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("plugin job claims store", () => {
  // Two independent connections against the same database, standing in for
  // two Paperclip replicas racing each other — mirrors run-ownership-store.test.ts.
  let db!: ReturnType<typeof createDb>;
  let db2!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-job-claims-");
    db = createDb(tempDb.connectionString);
    db2 = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
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

  async function seedJob(input: { pluginId: string; nextRunAt?: Date; status?: "active" | "paused" | "error" }) {
    const jobId = randomUUID();
    await db.insert(pluginJobs).values({
      id: jobId,
      pluginId: input.pluginId,
      jobKey: `job-${jobId.slice(0, 8)}`,
      schedule: "* * * * *",
      status: input.status ?? "active",
      nextRunAt: input.nextRunAt ?? new Date(),
    });
    return jobId;
  }

  async function cleanup(pluginId: string) {
    await db.delete(pluginJobRuns).where(eq(pluginJobRuns.pluginId, pluginId));
    await db.delete(pluginJobOccurrences).where(eq(pluginJobOccurrences.pluginId, pluginId));
    await db.delete(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
    await db.delete(plugins).where(eq(plugins.id, pluginId));
  }

  it("claimDueOccurrences reserves the occurrence and advances nextRunAt atomically, minting a monotonic fence", async () => {
    const pluginId = await seedPlugin();
    const now = new Date();
    const jobId = await seedJob({ pluginId, nextRunAt: new Date(now.getTime() - 1_000) });

    try {
      const future = new Date(now.getTime() + 60_000);
      const claims = await claimDueOccurrences(db, {
        now,
        limit: 10,
        computeNextRunAt: () => future,
      });

      expect(claims).toHaveLength(1);
      const claim = claims[0]!;
      expect(claim.job.id).toBe(jobId);
      expect(claim.occurrence.kind).toBe("scheduled");
      expect(claim.occurrence.ownerToken).toBeTruthy();
      expect(typeof claim.occurrence.fence).toBe("number");
      expect(claim.job.nextRunAt!.getTime()).toBe(future.getTime());
      expect(claim.run.status).toBe("queued");
      expect(claim.run.occurrenceId).toBe(claim.occurrence.id);

      // A second claim attempt at the same "now" finds nothing due — the
      // pointer already advanced past `now` inside the same transaction.
      const secondPass = await claimDueOccurrences(db, {
        now,
        limit: 10,
        computeNextRunAt: () => future,
      });
      expect(secondPass).toHaveLength(0);
    } finally {
      await cleanup(pluginId);
    }
  });

  it("two connections racing claimDueOccurrences on the same due job: exactly one wins", async () => {
    const pluginId = await seedPlugin();
    const now = new Date();
    await seedJob({ pluginId, nextRunAt: new Date(now.getTime() - 1_000) });

    try {
      const [resultA, resultB] = await Promise.all([
        claimDueOccurrences(db, { now, limit: 10, computeNextRunAt: () => new Date(now.getTime() + 60_000) }),
        claimDueOccurrences(db2, { now, limit: 10, computeNextRunAt: () => new Date(now.getTime() + 60_000) }),
      ]);

      const totalClaims = resultA.length + resultB.length;
      expect(totalClaims).toBe(1);
    } finally {
      await cleanup(pluginId);
    }
  });

  it("claimDueOccurrences respects isEligible without claiming or advancing the pointer for skipped rows", async () => {
    const pluginId = await seedPlugin();
    const now = new Date();
    const jobId = await seedJob({ pluginId, nextRunAt: new Date(now.getTime() - 1_000) });

    try {
      const claims = await claimDueOccurrences(db, {
        now,
        limit: 10,
        isEligible: () => false,
        computeNextRunAt: () => new Date(now.getTime() + 60_000),
      });
      expect(claims).toHaveLength(0);

      const [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.id, jobId));
      expect(job!.nextRunAt!.getTime()).toBe(now.getTime() - 1_000);

      const occurrences = await db.select().from(pluginJobOccurrences).where(eq(pluginJobOccurrences.jobId, jobId));
      expect(occurrences).toHaveLength(0);
    } finally {
      await cleanup(pluginId);
    }
  });

  it("claimDueOccurrences overfetches candidates so ineligible oldest-due jobs cannot starve later eligible ones, and never claims past limit", async () => {
    const pluginId = await seedPlugin();
    const now = new Date();
    const limit = 3;

    // 5 blocked (ineligible) jobs, oldest-first, followed by 5 eligible jobs,
    // all due. Without candidate overfetch, a plain `limit`-sized candidate
    // fetch would only ever see the oldest `limit` (blocked) rows and claim
    // nothing — the eligible jobs behind them would starve forever.
    const blockedJobIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      blockedJobIds.push(
        await seedJob({ pluginId, nextRunAt: new Date(now.getTime() - (10_000 - i)) }),
      );
    }
    const eligibleJobIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      eligibleJobIds.push(await seedJob({ pluginId, nextRunAt: new Date(now.getTime() - (4_000 - i)) }));
    }

    try {
      const claims = await claimDueOccurrences(db, {
        now,
        limit,
        isEligible: (job) => !blockedJobIds.includes(job.id),
        computeNextRunAt: () => new Date(now.getTime() + 60_000),
      });

      // The cap on how many occurrences are actually claimed is preserved.
      expect(claims).toHaveLength(limit);
      // Every claim came from the eligible pool — never a blocked job.
      for (const claim of claims) {
        expect(blockedJobIds).not.toContain(claim.job.id);
        expect(eligibleJobIds).toContain(claim.job.id);
      }
    } finally {
      await cleanup(pluginId);
    }
  });

  it("claimDueOccurrences overfetches past oldest jobs already holding a live occurrence (I4 guard) without starving later due jobs", async () => {
    const pluginId = await seedPlugin();
    const now = new Date();
    const limit = 3;

    // 4 oldest-due jobs each already have a live manual occurrence
    // (hasLiveOccurrence blocks them), followed by 4 due jobs with no
    // existing occurrence.
    const blockedJobIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const jobId = await seedJob({ pluginId, nextRunAt: new Date(now.getTime() - (10_000 - i)) });
      const claimed = await claimManualOccurrence(db, { jobId });
      expect(claimed).toBeTruthy();
      blockedJobIds.push(jobId);
    }
    const eligibleJobIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      eligibleJobIds.push(await seedJob({ pluginId, nextRunAt: new Date(now.getTime() - (4_000 - i)) }));
    }

    try {
      const claims = await claimDueOccurrences(db, {
        now,
        limit,
        computeNextRunAt: () => new Date(now.getTime() + 60_000),
      });

      expect(claims).toHaveLength(limit);
      for (const claim of claims) {
        expect(blockedJobIds).not.toContain(claim.job.id);
        expect(eligibleJobIds).toContain(claim.job.id);
      }
    } finally {
      await cleanup(pluginId);
    }
  });

  it("claimManualOccurrence refuses a second manual trigger while a live claim exists, but allows one after completion", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedJob({ pluginId });

    try {
      const first = await claimManualOccurrence(db, { jobId });
      expect(first).toBeTruthy();
      expect(first!.occurrence.kind).toBe("manual");
      expect(first!.occurrence.scheduledFor).toBeNull();

      const second = await claimManualOccurrence(db, { jobId });
      expect(second).toBeNull();

      const completed = await completeOccurrence(db, {
        occurrenceId: first!.occurrence.id,
        claim: first!.claim,
        runId: first!.run.id,
        status: "succeeded",
      });
      expect(completed).toBeTruthy();

      const third = await claimManualOccurrence(db, { jobId });
      expect(third).toBeTruthy();
    } finally {
      await cleanup(pluginId);
    }
  });

  it("acknowledgeOccurrence cannot resurrect an occurrence revoked between claim and acknowledge (B2)", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedJob({ pluginId });

    try {
      const claimed = await claimManualOccurrence(db, { jobId });
      expect(claimed).toBeTruthy();
      const { occurrence, claim } = claimed!;

      // Simulate the interleaving: unregister/disable revokes the
      // still-unacknowledged occurrence (status -> cancelled) while a
      // dispatch is in flight for it. revokeUnacknowledgedOccurrences does
      // NOT touch owner_token/fence, so `claim` still matches the row.
      const revoked = await revokeUnacknowledgedOccurrences(db, { pluginId, reason: "raced disable" });
      expect(revoked.map((o) => o.id)).toContain(occurrence.id);

      const [cancelledRow] = await db
        .select()
        .from(pluginJobOccurrences)
        .where(eq(pluginJobOccurrences.id, occurrence.id));
      expect(cancelledRow!.status).toBe("cancelled");

      // The in-flight dispatch now calls acknowledgeOccurrence with the
      // original (still claim-matching) claim. It must be rejected, not
      // resurrect the cancelled row back to "running".
      const ack = await acknowledgeOccurrence(db, { occurrenceId: occurrence.id, claim });
      expect(ack).toBeNull();

      const [row] = await db.select().from(pluginJobOccurrences).where(eq(pluginJobOccurrences.id, occurrence.id));
      expect(row!.status).toBe("cancelled");
      expect(row!.acknowledgedAt).toBeNull();
    } finally {
      await cleanup(pluginId);
    }
  });

  it("claimDueOccurrences and claimManualOccurrence never both dispatch a live occurrence for the same job (I4)", async () => {
    const pluginId = await seedPlugin();
    const now = new Date();
    const jobId = await seedJob({ pluginId, nextRunAt: new Date(now.getTime() - 1_000) });

    try {
      // Race a manual claim (db) against a scheduled claim (db2) for the
      // same due job — mirrors the "two connections racing" pattern above,
      // but across kinds. Whichever wins, the loser must see the row as
      // already live and back off; at most one live occurrence may exist.
      const [manualResult, scheduledResult] = await Promise.all([
        claimManualOccurrence(db, { jobId }),
        claimDueOccurrences(db2, { now, limit: 10, computeNextRunAt: () => new Date(now.getTime() + 60_000) }),
      ]);

      const claimedCount = (manualResult ? 1 : 0) + scheduledResult.length;
      expect(claimedCount).toBe(1);

      const liveOccurrences = await db
        .select()
        .from(pluginJobOccurrences)
        .where(
          sql`${pluginJobOccurrences.jobId} = ${jobId} and status in ('pending', 'queued', 'running') and lease_expires_at > now()`,
        );
      expect(liveOccurrences).toHaveLength(1);

      // Once the winner's occurrence is still live, a follow-up attempt via
      // the *other* path must also be refused — not just the first race.
      if (manualResult) {
        const followUpScheduled = await claimDueOccurrences(db, {
          now,
          limit: 10,
          computeNextRunAt: () => new Date(now.getTime() + 60_000),
        });
        expect(followUpScheduled).toHaveLength(0);
      } else {
        const followUpManual = await claimManualOccurrence(db, { jobId });
        expect(followUpManual).toBeNull();
      }
    } finally {
      await cleanup(pluginId);
    }
  });

  it("acknowledgeOccurrence and renewOccurrenceLease are fenced: stale claims are rejected without throwing", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedJob({ pluginId });

    try {
      const claimed = await claimManualOccurrence(db, { jobId });
      expect(claimed).toBeTruthy();
      const { occurrence, claim } = claimed!;

      const staleClaim: OccurrenceClaim = { ownerToken: "not-the-real-token", fence: claim.fence };
      const staleAck = await acknowledgeOccurrence(db, { occurrenceId: occurrence.id, claim: staleClaim });
      expect(staleAck).toBeNull();

      const ack = await acknowledgeOccurrence(db, { occurrenceId: occurrence.id, claim });
      expect(ack).toBeTruthy();
      expect(ack!.acknowledgedAt).toBeInstanceOf(Date);
      expect(ack!.status).toBe("running");

      const renewed = await renewOccurrenceLease(db, { occurrenceId: occurrence.id, claim });
      expect(renewed).toBeTruthy();
      expect(renewed!.leaseExpiresAt!.getTime()).toBeGreaterThan(occurrence.leaseExpiresAt!.getTime());

      const staleRenew = await renewOccurrenceLease(db, { occurrenceId: occurrence.id, claim: staleClaim });
      expect(staleRenew).toBeNull();
    } finally {
      await cleanup(pluginId);
    }
  });

  it("completeOccurrence rejects a stale/superseded claim and never overwrites the current owner's resolution", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedJob({ pluginId });

    try {
      const claimed = await claimManualOccurrence(db, { jobId });
      expect(claimed).toBeTruthy();
      const { occurrence, run, claim } = claimed!;

      // A peer takes over via db2 (simulating expired-lease reconciliation),
      // invalidating the original claim.
      const takeover = await takeoverExpiredOccurrence(db2, { occurrenceId: occurrence.id, graceMs: -1_000_000 });
      expect(takeover).toBeTruthy();
      expect(takeover!.occurrence.status).toBe("unknown");

      const staleComplete = await completeOccurrence(db, {
        occurrenceId: occurrence.id,
        claim,
        runId: run.id,
        status: "succeeded",
      });
      expect(staleComplete).toBeNull();

      // The takeover's "unknown" resolution must not have been overwritten.
      const [row] = await db.select().from(pluginJobOccurrences).where(eq(pluginJobOccurrences.id, occurrence.id));
      expect(row!.status).toBe("unknown");
    } finally {
      await cleanup(pluginId);
    }
  });

  it("isOccurrenceClaimStale reports true only on an actual owner/fence mismatch, false on a missing row", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedJob({ pluginId });

    try {
      const claimed = await claimManualOccurrence(db, { jobId });
      const { occurrence, claim } = claimed!;

      expect(await isOccurrenceClaimStale(db, { occurrenceId: occurrence.id, claim })).toBe(false);

      const takeover = await takeoverExpiredOccurrence(db2, { occurrenceId: occurrence.id, graceMs: -1_000_000 });
      expect(takeover).toBeTruthy();

      expect(await isOccurrenceClaimStale(db, { occurrenceId: occurrence.id, claim })).toBe(true);
      expect(await isOccurrenceClaimStale(db, { occurrenceId: randomUUID(), claim })).toBe(false);
    } finally {
      await cleanup(pluginId);
    }
  });

  it("findExpiredOccurrences and takeoverExpiredOccurrence: crash simulation never re-dispatches, only settles to 'unknown'", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedJob({ pluginId });

    try {
      const claimed = await claimManualOccurrence(db, { jobId, leaseTtlMs: 1 });
      const { occurrence, run } = claimed!;
      await acknowledgeOccurrence(db, { occurrenceId: occurrence.id, claim: claimed!.claim });

      // Force the lease into the past directly (simulating a crashed
      // executor whose renewal loop stopped) rather than waiting out a TTL.
      await db
        .update(pluginJobOccurrences)
        .set({ leaseExpiresAt: new Date(Date.now() - 60_000) })
        .where(eq(pluginJobOccurrences.id, occurrence.id));

      const expired = await findExpiredOccurrences(db, {});
      expect(expired.map((o) => o.id)).toContain(occurrence.id);

      const takeover = await takeoverExpiredOccurrence(db, { occurrenceId: occurrence.id });
      expect(takeover).toBeTruthy();
      expect(takeover!.occurrence.status).toBe("unknown");
      expect(takeover!.run!.status).toBe("unknown");
      expect(takeover!.occurrence.fence).toBeGreaterThan(claimed!.claim.fence!);

      // The crashed executor's original claim can no longer complete —
      // takeover must be the only path to resolution, never a blind replay.
      const deadComplete = await completeOccurrence(db, {
        occurrenceId: occurrence.id,
        claim: claimed!.claim,
        runId: run.id,
        status: "succeeded",
      });
      expect(deadComplete).toBeNull();

      // A second reconciler racing the same already-taken-over occurrence
      // finds nothing left to take over.
      const raced = await takeoverExpiredOccurrence(db2, { occurrenceId: occurrence.id });
      expect(raced).toBeNull();
    } finally {
      await cleanup(pluginId);
    }
  });

  it("revokeUnacknowledgedOccurrences cancels only unacknowledged occurrences, leaving acknowledged ones to drain", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedJob({ pluginId });

    try {
      const unacknowledged = await claimManualOccurrence(db, { jobId });
      expect(unacknowledged).toBeTruthy();

      const revoked = await revokeUnacknowledgedOccurrences(db, { pluginId, reason: "Plugin disabled" });
      expect(revoked.map((o) => o.id)).toContain(unacknowledged!.occurrence.id);

      const [row] = await db
        .select()
        .from(pluginJobOccurrences)
        .where(eq(pluginJobOccurrences.id, unacknowledged!.occurrence.id));
      expect(row!.status).toBe("cancelled");

      const [runRow] = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, unacknowledged!.run.id));
      expect(runRow!.status).toBe("cancelled");
      expect(runRow!.error).toBe("Plugin disabled");

      // Now the acknowledged case: dispatched occurrences are left alone.
      const acknowledgedClaim = await claimManualOccurrence(db, { jobId });
      expect(acknowledgedClaim).toBeTruthy();
      const ack = await acknowledgeOccurrence(db, {
        occurrenceId: acknowledgedClaim!.occurrence.id,
        claim: acknowledgedClaim!.claim,
      });
      expect(ack).toBeTruthy();

      await revokeUnacknowledgedOccurrences(db, { pluginId, reason: "Plugin disabled" });

      const [ackRow] = await db
        .select()
        .from(pluginJobOccurrences)
        .where(eq(pluginJobOccurrences.id, acknowledgedClaim!.occurrence.id));
      expect(ackRow!.status).toBe("running");
      expect(ackRow!.acknowledgedAt).toBeInstanceOf(Date);
    } finally {
      await cleanup(pluginId);
    }
  });

  it("the scheduled-occurrence partial unique index enforces one occurrence per due tick, but exempts manual triggers", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedJob({ pluginId });

    try {
      const scheduledFor = new Date();
      await db.execute(sql`
        INSERT INTO plugin_job_occurrences (job_id, plugin_id, kind, scheduled_for, owner_token, status)
        VALUES (${jobId}, ${pluginId}, 'scheduled', ${scheduledFor.toISOString()}, ${randomUUID()}, 'pending')
      `);

      await expect(
        db.execute(sql`
          INSERT INTO plugin_job_occurrences (job_id, plugin_id, kind, scheduled_for, owner_token, status)
          VALUES (${jobId}, ${pluginId}, 'scheduled', ${scheduledFor.toISOString()}, ${randomUUID()}, 'pending')
        `),
      ).rejects.toThrow();

      // Two manual occurrences for the same job (no scheduledFor) are not
      // constrained by the same index.
      await db.execute(sql`
        INSERT INTO plugin_job_occurrences (job_id, plugin_id, kind, owner_token, status)
        VALUES (${jobId}, ${pluginId}, 'manual', ${randomUUID()}, 'pending')
      `);
      await db.execute(sql`
        INSERT INTO plugin_job_occurrences (job_id, plugin_id, kind, owner_token, status)
        VALUES (${jobId}, ${pluginId}, 'manual', ${randomUUID()}, 'pending')
      `);
      const manualRows = await db
        .select()
        .from(pluginJobOccurrences)
        .where(sql`${pluginJobOccurrences.jobId} = ${jobId} and kind = 'manual'`);
      expect(manualRows).toHaveLength(2);
    } finally {
      await cleanup(pluginId);
    }
  });
});
