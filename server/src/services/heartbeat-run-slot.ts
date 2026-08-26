import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { parseHeartbeatPolicy } from "./heartbeat-policy.js";

/**
 * Claim one queued heartbeat run without exceeding the agent's concurrency cap.
 *
 * The in-process start lock is useful for reducing duplicate scheduler work, but
 * it cannot serialize separate Paperclip workers. Keep the capacity check and
 * queued -> running transition in one transaction protected by a per-agent
 * advisory lock so the limit remains strict across workers and restarts.
 */
export async function claimHeartbeatRunSlot(
  db: Db,
  input: {
    runId: string;
    agentId: string;
    startedAt: Date;
    responsibleUserId: string | null;
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

    return txDb
      .update(heartbeatRuns)
      .set({
        status: "running",
        responsibleUserId: input.responsibleUserId,
        startedAt: input.startedAt,
        updatedAt: input.startedAt,
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
