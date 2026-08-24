export type DeploymentProfile = "single_replica" | "multi_replica";

export interface MigrationConfig {
  deploymentProfile: DeploymentProfile;
  lockTimeoutMs: number;
}

const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

function parseDeploymentProfile(value: string | undefined): DeploymentProfile {
  const profile = value?.trim();
  if (profile && profile !== "single_replica" && profile !== "multi_replica") {
    throw new Error(
      `PAPERCLIP_DEPLOYMENT_PROFILE must be "single_replica" or "multi_replica", got: ${profile}`,
    );
  }
  return profile === "multi_replica" ? "multi_replica" : "single_replica";
}

function parseLockTimeout(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
  const timeoutMs = Number(value);
  return Number.isSafeInteger(timeoutMs) && timeoutMs >= 1_000
    ? timeoutMs
    : DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
}

function assertPostgresUrl(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${name} must use postgres:// or postgresql://`);
  }
}

export function resolveMigrationConfig(
  env: Record<string, string | undefined>,
  databaseUrl?: string,
  migrationUrl?: string,
): MigrationConfig {
  const deploymentProfile = parseDeploymentProfile(env.PAPERCLIP_DEPLOYMENT_PROFILE);
  const lockTimeoutMs = parseLockTimeout(env.PAPERCLIP_MIGRATION_LOCK_TIMEOUT_MS);

  if (deploymentProfile === "multi_replica") {
    if (!databaseUrl) {
      throw new Error("multi_replica profile requires external PostgreSQL via DATABASE_URL");
    }
    if (!migrationUrl) {
      throw new Error(
        "multi_replica profile requires a direct PostgreSQL DATABASE_MIGRATION_URL for session advisory locks",
      );
    }
    assertPostgresUrl(migrationUrl, "DATABASE_MIGRATION_URL");
    if (env.DATABASE_MIGRATION_SESSION_CAPABLE?.trim().toLowerCase() !== "true") {
      throw new Error(
        "multi_replica profile requires DATABASE_MIGRATION_SESSION_CAPABLE=true to attest that DATABASE_MIGRATION_URL is a direct, session-capable PostgreSQL endpoint",
      );
    }
  }

  return { deploymentProfile, lockTimeoutMs };
}
