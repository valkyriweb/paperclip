import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { parseHeartbeatPolicy } from "./heartbeat-policy.js";
import { DEFAULT_LEASE_TTL_MS, mintOwnerToken } from "./run-ownership-store.js";

/**
 * Claim one queued heartbeat run without exceeding the agent's concurrency cap.
 *
 * The in-process start lock is useful for reducing duplicate scheduler work, but
 * it cannot serialize separate Paperclip workers. Keep the capacity check and
 * queued -> running transition in one transaction protected by a per-agent
 * advisory lock so the limit remains strict across workers and restarts.
 *
 * The same transaction mints durable ownership: a fresh owner_token, a fence
 * pulled from the global heartbeat_run_fence_seq sequence (monotonic across
 * every run, so any later takeover is trivially comparable), and an initial
 * lease. See run-ownership-store.ts for how the rest of the run lifecycle
 * fences its writes against these columns.
 */
export async function claimHeartbeatRunSlot(
  db: Db,
  input: {
    runId: string;
    agentId: string;
    startedAt: Date;
    responsibleUserId: string | null;
    leaseTtlMs?: number;
  },
): Promise<typeof heartbeatRuns.$inferSelect | null> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await txDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`heartbeat-run-slot:${input.agentId}`}, 0))`,
    );

    const agent = await txDb
      .select()
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) return null;

    const [{ count }] = await txDb
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.status, "running")));
    if (Number(count ?? 0) >= parseHeartbeatPolicy(agent).maxConcurrentRuns) return null;

    const ownerToken = mintOwnerToken();
    const leaseExpiresAt = new Date(input.startedAt.getTime() + (input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS));

    return txDb
      .update(heartbeatRuns)
      .set({
        status: "running",
        responsibleUserId: input.responsibleUserId,
        startedAt: input.startedAt,
        updatedAt: input.startedAt,
        ownerToken,
        fence: sql`nextval('heartbeat_run_fence_seq')`,
        leaseExpiresAt,
        leaseRenewedAt: input.startedAt,
        claimAttempt: sql`${heartbeatRuns.claimAttempt} + 1`,
      })
      .where(
        and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.agentId, input.agentId),
          eq(heartbeatRuns.status, "queued"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
  });
}
