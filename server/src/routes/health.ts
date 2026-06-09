import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus, writeDevServerRestartRequest } from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { serverVersion } from "../version.js";

// Upper bound for any DB work performed while serving /health. Without this a
// saturated connection pool (all 10 runtime connections checked out by agent
// runs) makes the `SELECT 1` probe queue with no timeout, so the request hangs
// instead of returning a fast 503. Tunable via env for slow/remote Postgres.
const HEALTH_DB_PROBE_TIMEOUT_MS =
  Number.parseInt(process.env.PAPERCLIP_HEALTH_DB_TIMEOUT_MS ?? "", 10) || 2500;

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function shouldExposeFullHealthDetails(
  actorType: "none" | "board" | "agent" | null | undefined,
  deploymentMode: DeploymentMode,
) {
  if (deploymentMode !== "authenticated") return true;
  return actorType === "board" || actorType === "agent";
}

function hasDevServerStatusToken(providedToken: string | undefined) {
  const expectedToken = process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN?.trim();
  const token = providedToken?.trim();
  if (!expectedToken || !token) return false;

  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(token);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();

  router.post("/dev-server/restart", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    if (opts.deploymentMode === "authenticated" && actorType !== "board") {
      res.status(403).json({ error: "board_access_required" });
      return;
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    if (!persistedDevServerStatus) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    const restartRequired =
      persistedDevServerStatus.dirty ||
      persistedDevServerStatus.changedPathCount > 0 ||
      persistedDevServerStatus.pendingMigrations.length > 0;
    if (!restartRequired) {
      res.status(409).json({ error: "restart_not_required" });
      return;
    }

    const written = writeDevServerRestartRequest({
      requestedAt: new Date().toISOString(),
      reason: "manual_restart_now",
    });
    if (!written) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    res.status(202).json({ status: "restart_requested" });
  });

  // Liveness: process-up only, never touches the database. Wire the k8s
  // livenessProbe here so a Postgres blip can never trigger a restart storm;
  // keep readiness (below) for the DB-dependent checks.
  router.get("/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    const exposeFullDetails = shouldExposeFullHealthDetails(
      actorType,
      opts.deploymentMode,
    );
    const exposeDevServerDetails =
      exposeFullDetails || hasDevServerStatusToken(req.get("x-paperclip-dev-server-status-token"));

    if (!db) {
      res.json(
        exposeFullDetails
          ? { status: "ok", version: serverVersion }
          : { status: "ok", deploymentMode: opts.deploymentMode },
      );
      return;
    }

    try {
      await withTimeout(
        db.execute(sql`SELECT 1`),
        HEALTH_DB_PROBE_TIMEOUT_MS,
        "health_db_probe",
      );
    } catch (error) {
      logger.warn({ err: error }, "Health check database probe failed");
      res.status(503).json({
        status: "unhealthy",
        version: serverVersion,
        error: "database_unreachable"
      });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    if (opts.deploymentMode === "authenticated") {
      try {
        const roleCount = await withTimeout(
          db
            .select({ count: count() })
            .from(instanceUserRoles)
            .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
            .then((rows) => Number(rows[0]?.count ?? 0)),
          HEALTH_DB_PROBE_TIMEOUT_MS,
          "health_bootstrap_role_count",
        );
        bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

        if (bootstrapStatus === "bootstrap_pending") {
          const now = new Date();
          const inviteCount = await withTimeout(
            db
              .select({ count: count() })
              .from(invites)
              .where(
                and(
                  eq(invites.inviteType, "bootstrap_ceo"),
                  isNull(invites.revokedAt),
                  isNull(invites.acceptedAt),
                  gt(invites.expiresAt, now),
                ),
              )
              .then((rows) => Number(rows[0]?.count ?? 0)),
            HEALTH_DB_PROBE_TIMEOUT_MS,
            "health_bootstrap_invite_count",
          );
          bootstrapInviteActive = inviteCount > 0;
        }
      } catch (error) {
        logger.warn({ err: error }, "Health check bootstrap probe failed");
        res.status(503).json({
          status: "unhealthy",
          version: serverVersion,
          error: "database_unreachable",
        });
        return;
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (exposeDevServerDetails && persistedDevServerStatus && typeof (db as { select?: unknown }).select === "function") {
      // Optional diagnostic detail — bound it and degrade (omit devServer)
      // rather than failing health if these secondary queries stall.
      try {
        const instanceSettings = instanceSettingsService(db);
        const experimentalSettings = await withTimeout(
          instanceSettings.getExperimental(),
          HEALTH_DB_PROBE_TIMEOUT_MS,
          "health_dev_server_settings",
        );
        const activeRunCount = await withTimeout(
          db
            .select({ count: count() })
            .from(heartbeatRuns)
            .where(inArray(heartbeatRuns.status, ["queued", "running"]))
            .then((rows) => Number(rows[0]?.count ?? 0)),
          HEALTH_DB_PROBE_TIMEOUT_MS,
          "health_active_run_count",
        );

        devServer = toDevServerHealthStatus(persistedDevServerStatus, {
          autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
          activeRunCount,
        });
      } catch (error) {
        logger.warn({ err: error }, "Health check dev-server detail probe timed out; omitting devServer");
      }
    }

    if (!exposeFullDetails) {
      res.json({
        status: "ok",
        deploymentMode: opts.deploymentMode,
        bootstrapStatus,
        bootstrapInviteActive,
        ...(devServer ? { devServer } : {}),
      });
      return;
    }

    res.json({
      status: "ok",
      version: serverVersion,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      ...(devServer ? { devServer } : {}),
    });
  });

  return router;
}
