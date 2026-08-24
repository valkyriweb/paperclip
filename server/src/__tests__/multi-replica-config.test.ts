import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function configureIsolatedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-ha-config-"));
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_CONFIG = path.join(home, "config.json");
  process.env.PAPERCLIP_DEPLOYMENT_PROFILE = "multi_replica";
}

describe("multi-replica database configuration", () => {
  it("requires external PostgreSQL", () => {
    configureIsolatedHome();
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_MIGRATION_URL;

    expect(() => loadConfig()).toThrow("multi_replica profile requires external PostgreSQL");
  });

  it("requires a direct migration URL", () => {
    configureIsolatedHome();
    process.env.DATABASE_URL = "postgres://app@paperclip-pg-rw:5432/paperclip";
    delete process.env.DATABASE_MIGRATION_URL;

    expect(() => loadConfig()).toThrow("requires a direct PostgreSQL DATABASE_MIGRATION_URL");
  });

  it("rejects common transaction-pooler endpoints", () => {
    configureIsolatedHome();
    process.env.DATABASE_URL = "postgres://app@db.example.test:6543/paperclip";
    process.env.DATABASE_MIGRATION_URL = "postgres://migration@db-pooler.example.test:6543/paperclip";

    expect(() => loadConfig()).toThrow("not a transaction pooler");
  });

  it.each([
    "postgres://migration@paperclip-pg-rw:5432/paperclip",
    "postgres://migration@aws-0-region.pooler.supabase.com:5432/postgres",
  ])("accepts a direct session-capable migration endpoint: %s", (migrationUrl) => {
    configureIsolatedHome();
    process.env.DATABASE_URL = "postgres://app@paperclip-pg-rw:5432/paperclip";
    process.env.DATABASE_MIGRATION_URL = migrationUrl;
    process.env.PAPERCLIP_MIGRATION_LOCK_TIMEOUT_MS = "90000";

    const config = loadConfig();
    expect(config.deploymentProfile).toBe("multi_replica");
    expect(config.migrationLockTimeoutMs).toBe(90_000);
  });
});
