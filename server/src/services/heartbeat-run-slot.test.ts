import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { claimHeartbeatRunSlot } from "./heartbeat-run-slot.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat run slot claims", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-run-slot-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("never over-admits concurrent claims across independent callers", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runIds = Array.from({ length: 8 }, () => randomUUID());

    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic concurrency company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Synthetic concurrency agent",
      role: "engineer",
      status: "active",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 3 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values(
      runIds.map((id) => ({
        id,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "assignment",
        contextSnapshot: {},
      })),
    );

    try {
      const claims = await Promise.all(
        runIds.map((runId) =>
          claimHeartbeatRunSlot(db, {
            runId,
            agentId,
            startedAt: new Date(),
            responsibleUserId: "responsible-user",
          }),
        ),
      );

      expect(claims.filter(Boolean)).toHaveLength(3);
      const statuses = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(statuses.filter((row) => row.status === "running")).toHaveLength(3);
      expect(statuses.filter((row) => row.status === "queued")).toHaveLength(5);
    } finally {
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      await db.delete(agents).where(eq(agents.id, agentId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
  });
});
