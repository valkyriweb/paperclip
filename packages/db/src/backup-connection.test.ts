import { describe, expect, it } from "vitest";
import { nativeBackupConnectionEnv } from "./backup-connection.js";

describe("native backup connection", () => {
  it("decodes credentials and database names and retains IPv6 and TLS options", () => {
    expect(nativeBackupConnectionEnv("postgresql://user%40tenant:p%3Ass@[::1]:5433/db%20name?sslmode=verify-full&application_name=backup", 12)).toMatchObject({
      PGHOST: "::1", PGPORT: "5433", PGUSER: "user@tenant", PGPASSWORD: "p:ss",
      PGDATABASE: "db name", PGSSLMODE: "verify-full", PGAPPNAME: "backup", PGCONNECT_TIMEOUT: "12",
    });
  });
  it("preserves query overrides and encoded Unix socket paths", () => {
    expect(nativeBackupConnectionEnv("postgresql://localhost/ignored?host=%2Ftmp&dbname=actual&user=other", 1)).toMatchObject({ PGHOST: "/tmp", PGDATABASE: "actual", PGUSER: "other" });
  });
  it("rejects unsupported options instead of silently changing the connection", () => {
    expect(() => nativeBackupConnectionEnv("postgresql://localhost/db?unknown=synthetic-value", 1)).toThrow("no supported libpq environment mapping");
  });
  it("does not include invalid connection values in errors", () => {
    expect(() => nativeBackupConnectionEnv("not-a-url-with-synthetic-secret", 1)).toThrow("valid PostgreSQL connection URL");
  });
});
