import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { MigrationCoordinator } from "./migration-coordinator.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

async function main(): Promise<void> {
  const resolved = await resolveMigrationConnection();

  console.log(`Migrating database via ${resolved.source}`);

  try {
    const runMigrations = async () => {
      const before = await inspectMigrations(resolved.connectionString);
      if (before.status === "upToDate") {
        console.log("No pending migrations");
        return;
      }

      console.log(`Applying ${before.pendingMigrations.length} pending migration(s)...`);
      await applyPendingMigrations(resolved.connectionString);

      const after = await inspectMigrations(resolved.connectionString);
      if (after.status !== "upToDate") {
        throw new Error(`Migrations incomplete: ${after.pendingMigrations.join(", ")}`);
      }
      console.log("Migrations complete");
    };

    if (resolved.mode === "postgres") {
      const coordinator = new MigrationCoordinator(resolved.connectionString);
      await coordinator.withExclusiveMigrationLock(runMigrations, {
        timeoutMs: resolved.lockTimeoutMs,
        onStateChange: (state) => {
          console.log(`Migration coordination: ${state} (lock ${coordinator.lockId})`);
        },
      });
    } else {
      await runMigrations();
    }
  } finally {
    await resolved.stop();
  }
}

await main();
