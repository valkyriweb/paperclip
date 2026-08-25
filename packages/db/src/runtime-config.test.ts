import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMigrationConnection } from "./migration-runtime.js";
import { resolveDatabaseTarget } from "./runtime-config.js";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeText(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveDatabaseTarget", () => {
  it("uses DATABASE_MIGRATION_URL first for migration commands", () => {
    process.env.DATABASE_URL = "postgres://app@pooler.example.com:6543/paperclip";
    process.env.DATABASE_MIGRATION_URL = "postgres://migrator@primary.example.com:5432/paperclip";

    const target = resolveDatabaseTarget({ preferMigrationUrl: true });

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://migrator@primary.example.com:5432/paperclip",
      source: "DATABASE_MIGRATION_URL",
    });
  });

  it.each([
    { key: "DATABASE_URL", value: "" },
    { key: "DATABASE_URL", value: "  \t  " },
    { key: "DATABASE_MIGRATION_URL", value: "" },
    { key: "DATABASE_MIGRATION_URL", value: "  \t  " },
  ] as const)("fails closed for a defined-blank process $key", async ({ key, value }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
    for (const envKey of [
      "PAPERCLIP_DEPLOYMENT_PROFILE",
      "DATABASE_URL",
      "DATABASE_MIGRATION_URL",
      "DATABASE_MIGRATION_SESSION_CAPABLE",
      "PAPERCLIP_MIGRATION_LOCK_TIMEOUT_MS",
    ]) delete process.env[envKey];
    writeText(
      path.join(path.dirname(configPath), ".env"),
      "PAPERCLIP_DEPLOYMENT_PROFILE=multi_replica\n" +
        "DATABASE_URL=postgres://lower-runtime@runtime.example.com/paperclip\n" +
        "DATABASE_MIGRATION_URL=postgres://lower-migration@migration.example.com/paperclip\n" +
        "DATABASE_MIGRATION_SESSION_CAPABLE=true\n",
    );
    process.env[key] = value;

    await expect(resolveMigrationConnection()).rejects.toThrow(
      `${key} must not be blank when defined`,
    );
  });

  it.each([
    { key: "DATABASE_URL", value: "''" },
    { key: "DATABASE_URL", value: "'  \t  '" },
    { key: "DATABASE_MIGRATION_URL", value: "''" },
    { key: "DATABASE_MIGRATION_URL", value: "'  \t  '" },
  ] as const)("does not fall through a defined-blank config-adjacent $key", async ({ key, value }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const projectDir = path.join(tempDir, "repo");
    const configPath = path.join(projectDir, ".paperclip", "config.json");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    process.env.PAPERCLIP_CONFIG = configPath;
    for (const envKey of [
      "PAPERCLIP_DEPLOYMENT_PROFILE",
      "DATABASE_URL",
      "DATABASE_MIGRATION_URL",
      "DATABASE_MIGRATION_SESSION_CAPABLE",
      "PAPERCLIP_MIGRATION_LOCK_TIMEOUT_MS",
    ]) delete process.env[envKey];
    writeText(
      path.join(projectDir, ".env"),
      "DATABASE_URL=postgres://cwd-runtime@runtime.example.com/paperclip\n" +
        "DATABASE_MIGRATION_URL=postgres://cwd-migration@migration.example.com/paperclip\n",
    );
    writeText(
      path.join(path.dirname(configPath), ".env"),
      "PAPERCLIP_DEPLOYMENT_PROFILE=multi_replica\n" +
        "DATABASE_MIGRATION_SESSION_CAPABLE=true\n" +
        `${key}=${value}\n`,
    );

    await expect(resolveMigrationConnection()).rejects.toThrow(
      `${key} must not be blank when defined`,
    );
  });

  it("uses DATABASE_MIGRATION_URL from repo-local .paperclip/.env", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_MIGRATION_URL;
    writeJson(path.join(projectDir, ".paperclip", "config.json"), {
      database: { mode: "embedded-postgres", embeddedPostgresPort: 54329 },
    });
    writeText(
      path.join(projectDir, ".paperclip", ".env"),
      "PAPERCLIP_DEPLOYMENT_PROFILE=multi_replica\n" +
        "DATABASE_URL=postgres://app@pooler.example.com:6543/paperclip\n" +
        "DATABASE_MIGRATION_URL=postgres://migrator@primary.example.com:5432/paperclip\n" +
        "DATABASE_MIGRATION_SESSION_CAPABLE=true\n" +
        "PAPERCLIP_MIGRATION_LOCK_TIMEOUT_MS=90000\n",
    );

    const target = resolveDatabaseTarget({ preferMigrationUrl: true });

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://migrator@primary.example.com:5432/paperclip",
      source: "paperclip-env:DATABASE_MIGRATION_URL",
    });
  });

  it("shares CWD root env URL, profile, attestation, and timeout with migration commands", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    for (const key of [
      "PAPERCLIP_CONFIG",
      "PAPERCLIP_DEPLOYMENT_PROFILE",
      "DATABASE_URL",
      "DATABASE_MIGRATION_URL",
      "DATABASE_MIGRATION_SESSION_CAPABLE",
      "PAPERCLIP_MIGRATION_LOCK_TIMEOUT_MS",
    ]) delete process.env[key];
    writeJson(path.join(projectDir, ".paperclip", "config.json"), {
      database: {
        mode: "postgres",
        connectionString: "postgres://config@fallback.example.com:5432/paperclip",
      },
    });
    writeText(
      path.join(projectDir, ".env"),
      "PAPERCLIP_DEPLOYMENT_PROFILE=multi_replica\n" +
        "DATABASE_URL=postgres://app@pooler.example.com:6543/paperclip\n" +
        "DATABASE_MIGRATION_URL=postgres://migrator@primary.example.com:5432/paperclip\n" +
        "DATABASE_MIGRATION_SESSION_CAPABLE=true\n" +
        "PAPERCLIP_MIGRATION_LOCK_TIMEOUT_MS=91000\n",
    );

    const connection = await resolveMigrationConnection();

    expect(connection).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://migrator@primary.example.com:5432/paperclip",
      source: "cwd-env:DATABASE_MIGRATION_URL",
      lockTimeoutMs: 91_000,
    });
  });

  it("keeps process env above config-adjacent and CWD env", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    writeJson(path.join(projectDir, ".paperclip", "config.json"), { database: { mode: "postgres" } });
    writeText(path.join(projectDir, ".env"), "DATABASE_URL=postgres://cwd@cwd.example.com/paperclip\n");
    writeText(
      path.join(projectDir, ".paperclip", ".env"),
      "DATABASE_URL=postgres://paperclip@paperclip.example.com/paperclip\n",
    );
    process.env.DATABASE_URL = "postgres://process@process.example.com/paperclip";

    expect(resolveDatabaseTarget()).toMatchObject({
      connectionString: "postgres://process@process.example.com/paperclip",
      source: "DATABASE_URL",
    });
  });

  it("shares repo-local multi-replica validation and timeout with migration commands", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_DEPLOYMENT_PROFILE;
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_MIGRATION_URL;
    delete process.env.DATABASE_MIGRATION_SESSION_CAPABLE;
    delete process.env.PAPERCLIP_MIGRATION_LOCK_TIMEOUT_MS;
    writeJson(path.join(projectDir, ".paperclip", "config.json"), {
      database: { mode: "postgres" },
    });
    writeText(
      path.join(projectDir, ".paperclip", ".env"),
      "PAPERCLIP_DEPLOYMENT_PROFILE=multi_replica\n" +
        "DATABASE_URL=postgres://app@pooler.example.com:6543/paperclip\n" +
        "DATABASE_MIGRATION_URL=postgres://migrator@primary.example.com:5432/paperclip\n" +
        "DATABASE_MIGRATION_SESSION_CAPABLE=true\n" +
        "PAPERCLIP_MIGRATION_LOCK_TIMEOUT_MS=90000\n",
    );

    const connection = await resolveMigrationConnection();

    expect(connection).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://migrator@primary.example.com:5432/paperclip",
      source: "paperclip-env:DATABASE_MIGRATION_URL",
      lockTimeoutMs: 90_000,
    });
  });

  it("uses DATABASE_URL from process env first", () => {
    process.env.DATABASE_URL = "postgres://env-user:env-pass@db.example.com:5432/paperclip";

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://env-user:env-pass@db.example.com:5432/paperclip",
      source: "DATABASE_URL",
    });
  });

  it("uses DATABASE_URL from repo-local .paperclip/.env", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    delete process.env.PAPERCLIP_CONFIG;
    writeJson(path.join(projectDir, ".paperclip", "config.json"), {
      database: { mode: "embedded-postgres", embeddedPostgresPort: 54329 },
    });
    writeText(
      path.join(projectDir, ".paperclip", ".env"),
      'DATABASE_URL="postgres://file-user:file-pass@db.example.com:6543/paperclip"\n',
    );

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://file-user:file-pass@db.example.com:6543/paperclip",
      source: "paperclip-env",
    });
  });

  it("uses config postgres connection string when configured", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
    writeJson(configPath, {
      database: {
        mode: "postgres",
        connectionString: "postgres://cfg-user:cfg-pass@db.example.com:5432/paperclip",
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://cfg-user:cfg-pass@db.example.com:5432/paperclip",
      source: "config.database.connectionString",
    });
  });

  it("falls back to embedded postgres settings from config", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
    writeJson(configPath, {
      database: {
        mode: "embedded-postgres",
        embeddedPostgresDataDir: "~/paperclip-test-db",
        embeddedPostgresPort: 55444,
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      dataDir: path.resolve(os.homedir(), "paperclip-test-db"),
      port: 55444,
      source: "embedded-postgres@55444",
    });
  });

  it("uses the instance root for a fresh default embedded postgres target", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-cwd-"));
    process.chdir(cwd);
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.DATABASE_URL;

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      dataDir: path.join(home, "instances", "default", "db"),
      port: 54329,
      source: "embedded-postgres@54329",
      configPath: path.join(home, "instances", "default", "config.json"),
      envPath: path.join(home, "instances", "default", ".env"),
    });
  });
});
