import { describe, expect, it } from "vitest";
import {
  DEFAULT_DB_IDLE_TIMEOUT_SEC,
  DEFAULT_DB_IDLE_IN_TX_TIMEOUT_MS,
  DEFAULT_DB_MAX_LIFETIME_SEC,
  DEFAULT_DB_STATEMENT_TIMEOUT_MS,
  databaseClientOptionsFromEnv,
  postgresJsOptions,
} from "./client.js";

// Fork: when nothing is set, idle/lifetime bounds and session guards default
// on instead of preserving the driver's unbounded behaviour (CNPG
// smart-shutdown fix; pool-starvation-503 fix).
const FORK_DEFAULTS = {
  idleTimeoutSeconds: DEFAULT_DB_IDLE_TIMEOUT_SEC,
  maxLifetimeSeconds: DEFAULT_DB_MAX_LIFETIME_SEC,
  statementTimeoutMs: DEFAULT_DB_STATEMENT_TIMEOUT_MS,
  idleInTransactionTimeoutMs: DEFAULT_DB_IDLE_IN_TX_TIMEOUT_MS,
};

describe("databaseClientOptionsFromEnv", () => {
  it("returns only fork pool bounds when nothing is set", () => {
    expect(databaseClientOptionsFromEnv({})).toEqual(FORK_DEFAULTS);
    expect(postgresJsOptions(databaseClientOptionsFromEnv({}))).toEqual({
      idle_timeout: DEFAULT_DB_IDLE_TIMEOUT_SEC,
      max_lifetime: DEFAULT_DB_MAX_LIFETIME_SEC,
      connection: {
        statement_timeout: DEFAULT_DB_STATEMENT_TIMEOUT_MS,
        idle_in_transaction_session_timeout: DEFAULT_DB_IDLE_IN_TX_TIMEOUT_MS,
      },
    });
  });

  it("ignores empty values", () => {
    expect(
      databaseClientOptionsFromEnv({
        DATABASE_PREPARED_STATEMENTS: "",
        DATABASE_POOL_MAX: "",
      }),
    ).toEqual(FORK_DEFAULTS);
  });

  it("parses prepared-statement toggles", () => {
    expect(databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "false" })).toEqual({ prepare: false, ...FORK_DEFAULTS });
    expect(databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "0" })).toEqual({ prepare: false, ...FORK_DEFAULTS });
    expect(databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "true" })).toEqual({ prepare: true, ...FORK_DEFAULTS });
    expect(databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "TRUE" })).toEqual({ prepare: true, ...FORK_DEFAULTS });
  });

  it("parses pool and timeout settings", () => {
    expect(
      databaseClientOptionsFromEnv({
        DATABASE_POOL_MAX: "25",
        DATABASE_IDLE_TIMEOUT_SECONDS: "60",
        DATABASE_CONNECT_TIMEOUT_SECONDS: "10",
      }),
    ).toEqual({
      maxConnections: 25,
      idleTimeoutSeconds: 60,
      connectTimeoutSeconds: 10,
      maxLifetimeSeconds: DEFAULT_DB_MAX_LIFETIME_SEC,
      statementTimeoutMs: DEFAULT_DB_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: DEFAULT_DB_IDLE_IN_TX_TIMEOUT_MS,
    });
  });

  it("rejects malformed values instead of silently ignoring them", () => {
    expect(() => databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "maybe" })).toThrow(
      /DATABASE_PREPARED_STATEMENTS/,
    );
    expect(() => databaseClientOptionsFromEnv({ DATABASE_POOL_MAX: "0" })).toThrow(/DATABASE_POOL_MAX/);
    expect(() => databaseClientOptionsFromEnv({ DATABASE_POOL_MAX: "-3" })).toThrow(/DATABASE_POOL_MAX/);
    expect(() => databaseClientOptionsFromEnv({ DATABASE_CONNECT_TIMEOUT_SECONDS: "1.5" })).toThrow(
      /DATABASE_CONNECT_TIMEOUT_SECONDS/,
    );
  });

  it("maps to postgres.js option names", () => {
    expect(
      postgresJsOptions({
        prepare: false,
        maxConnections: 25,
        idleTimeoutSeconds: 60,
        connectTimeoutSeconds: 10,
      }),
    ).toEqual({ prepare: false, max: 25, idle_timeout: 60, connect_timeout: 10 });
  });
});
