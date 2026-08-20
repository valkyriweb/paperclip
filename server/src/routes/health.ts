import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus, writeDevServerRestartRequest } from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import { getServerInfoSnapshot, type ServerInfoSnapshot } from "../server-info.js";
import {
  getCloudStackContext,
  isCloudManagedInstance,
  type CloudInstanceEnv,
} from "../services/cloud-instance.js";
import {
  inspectDatabaseBackupHealth,
  type DatabaseBackupHealthStatus,
  type DatabaseBackupHealthWarning,
  type InspectDatabaseBackupHealthOptions,
} from "../services/database-backup-health.js";
import { getEventLoopLagSnapshot } from "../services/event-loop-lag.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { serverVersion } from "../version.js";

function shouldExposeFullHealthDetails(
  actorType: "none" | "board" | "agent" | null | undefined,
  deploymentMode: DeploymentMode,
) {
  if (deploymentMode !== "authenticated") return true;
  return actorType === "board" || actorType === "agent";
}

const HEALTH_DB_PROBE_TIMEOUT_MS = 3000;

// After a probe failure, keep reporting ready (200 "degraded") for this long
// past the last successful probe. A slow-but-alive database (e.g. the main
// pool starved by one long maintenance statement) should not immediately drop
// the sole pod from the load balancer and turn a slowdown into a full outage;
// only a persistently failing probe hard-fails readiness.
const HEALTH_DB_DEGRADED_GRACE_MS = 60_000;

// Bounds the readiness probe's DB round-trip so pool starvation (e.g. every
// connection wedged in a nested-transaction deadlock) fails fast with a
// 503/database_unreachable response instead of hanging past the readiness
// probe's own timeout and taking the whole instance out silently (#89).
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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

function redactedDatabaseBackupWarning(warning: DatabaseBackupHealthWarning): DatabaseBackupHealthWarning {
  const messages: Record<DatabaseBackupHealthWarning["code"], string> = {
    database_backup_check_failed: "Database backup health check failed.",
    database_backup_last_failure: "Database backup failure marker is present.",
    database_backup_missing: "No recent database backup was found.",
    database_backup_stale: "Latest database backup is stale.",
  };
  return {
    code: warning.code,
    message: messages[warning.code],
  };
}

function redactedDatabaseBackupHealth(databaseBackup: DatabaseBackupHealthStatus) {
  return {
    enabled: databaseBackup.enabled,
    status: databaseBackup.status,
    warnings: databaseBackup.warnings.map(redactedDatabaseBackupWarning),
  };
}

function getCloudHealthStatus(env: CloudInstanceEnv) {
  const context = getCloudStackContext(env);
  if (!context) return undefined;

  return {
    managed: true as const,
    managedBy: "paperclip-cloud" as const,
    stackSlug: context.stackSlug,
    cloudBaseUrl: context.cloudOrigin,
  };
}

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    serverInfo?: ServerInfoSnapshot;
    databaseBackupHealth?: InspectDatabaseBackupHealthOptions;
    runtimeEnv?: CloudInstanceEnv;
    /**
     * Dedicated single-connection client for the DB probe. With it, main-pool
     * starvation no longer equals probe failure: the probe answers from its
     * own connection while the pool is saturated.
     */
    probeDb?: Pick<Db, "execute">;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();
  let lastDbProbeSuccessAt: number | null = null;

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

  router.get("/", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    const exposeFullDetails = shouldExposeFullHealthDetails(
      actorType,
      opts.deploymentMode,
    );
    const runtimeEnv = opts.runtimeEnv ?? process.env;
    const cloud = getCloudHealthStatus(runtimeEnv);
    // serverInfo (git SHA + process start) rides on the full-details responses
    // only, so it reaches board/agent actors in authenticated mode or any caller
    // in local_trusted dev — never anonymous authenticated callers. The
    // enableServerInfoDebugView experimental flag gates the UI surface, not this
    // already access-controlled field.
    const serverInfo = opts.serverInfo ?? getServerInfoSnapshot();
    // The build commit is a plain git SHA of a public repository — not a
    // secret — so it is surfaced on every response, including the redacted
    // one, unlike the fuller `serverInfo` block. Deploy tooling (and anyone)
    // can read which commit this server is running without authenticating.
    const commit = serverInfo.git.available ? serverInfo.git.fullSha : null;
    const exposeDevServerDetails =
      exposeFullDetails || hasDevServerStatusToken(req.get("x-paperclip-dev-server-status-token"));

    if (!db) {
      res.json(
        exposeFullDetails
          ? {
              status: "ok",
              version: serverVersion,
              serverVersion: serverVersion,
              commit,
              serverInfo,
              ...(cloud ? { cloud } : {}),
            }
          : {
              status: "ok",
              deploymentMode: opts.deploymentMode,
              commit,
              ...(cloud ? { cloud } : {}),
            },
      );
      return;
    }

    try {
      const probeDb = opts.probeDb ?? db;
      await withTimeout(probeDb.execute(sql`SELECT 1`), HEALTH_DB_PROBE_TIMEOUT_MS, "Health check database probe");
      lastDbProbeSuccessAt = Date.now();
    } catch (error) {
      const withinGrace =
        lastDbProbeSuccessAt !== null && Date.now() - lastDbProbeSuccessAt <= HEALTH_DB_DEGRADED_GRACE_MS;
      logger.warn(
        { err: error, withinGrace, eventLoopLag: getEventLoopLagSnapshot() },
        withinGrace
          ? "Health check database probe failed; reporting degraded within grace window"
          : "Health check database probe failed",
      );
      if (withinGrace) {
        // Degrade instead of hard-failing readiness: skip every further DB
        // query on this path (they would hang on the same starved pool).
        res.json({
          status: "degraded",
          version: serverVersion,
          serverVersion,
          commit,
          warning: "database_slow",
          ...(exposeFullDetails ? { serverInfo, eventLoopLag: getEventLoopLagSnapshot() } : {}),
          ...(cloud ? { cloud } : {}),
        });
        return;
      }
      res.status(503).json({
        status: "unhealthy",
        version: serverVersion,
        serverVersion,
        commit,
        error: "database_unreachable",
        ...(exposeFullDetails ? { serverInfo, eventLoopLag: getEventLoopLagSnapshot() } : {}),
        ...(cloud ? { cloud } : {}),
      });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    // Cloud-managed instances have no first-admin concept: the control
    // plane owns identity and its trusted-header users are deliberately
    // never instance_admin, so the role-count gate below would report
    // bootstrap_pending forever and lock every managed tenant out at the
    // claim screen. Self-hosted deployments (neither canonical managed signal)
    // are unaffected.
    if (opts.deploymentMode === "authenticated" && !isCloudManagedInstance(runtimeEnv)) {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

      if (bootstrapStatus === "bootstrap_pending") {
        const now = new Date();
        const inviteCount = await db
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
          .then((rows) => Number(rows[0]?.count ?? 0));
        bootstrapInviteActive = inviteCount > 0;
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (exposeDevServerDetails && persistedDevServerStatus && typeof (db as { select?: unknown }).select === "function") {
      const instanceSettings = instanceSettingsService(db);
      const experimentalSettings = await instanceSettings.getExperimental();
      const activeRunCount = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]))
        .then((rows) => Number(rows[0]?.count ?? 0));

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
        activeRunCount,
      });
    }

    const databaseBackup = opts.databaseBackupHealth
      ? inspectDatabaseBackupHealth(opts.databaseBackupHealth)
      : undefined;
    const warnings = databaseBackup?.warnings.length ? databaseBackup.warnings : undefined;

    if (!exposeFullDetails) {
      const redactedDatabaseBackup = databaseBackup ? redactedDatabaseBackupHealth(databaseBackup) : undefined;
      const redactedWarnings = redactedDatabaseBackup?.warnings.length ? redactedDatabaseBackup.warnings : undefined;
      res.json({
        status: "ok",
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        commit,
        bootstrapStatus,
        bootstrapInviteActive,
        ...(redactedDatabaseBackup ? { databaseBackup: redactedDatabaseBackup } : {}),
        ...(redactedWarnings ? { warnings: redactedWarnings } : {}),
        ...(devServer ? { devServer } : {}),
        ...(cloud ? { cloud } : {}),
      });
      return;
    }

    res.json({
      status: "ok",
      version: serverVersion,
      serverVersion,
      commit,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      serverInfo,
      eventLoopLag: getEventLoopLagSnapshot(),
      ...(databaseBackup ? { databaseBackup } : {}),
      ...(warnings ? { warnings } : {}),
      ...(devServer ? { devServer } : {}),
      ...(cloud ? { cloud } : {}),
    });
  });

  return router;
}
