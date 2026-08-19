import { describe, expect, it } from "vitest";
import {
  DEFAULT_DB_IDLE_TIMEOUT_SEC,
  DEFAULT_DB_MAX_LIFETIME_SEC,
  databaseClientOptionsFromEnv,
  postgresJsOptions,
} from "./client.js";

const driverOptionsFromEnv = (env: NodeJS.ProcessEnv) =>
  postgresJsOptions(databaseClientOptionsFromEnv(env));

describe("fork pool timeout defaults", () => {
  it("bounds idle connections by default so smart shutdown is not blocked", () => {
    expect(driverOptionsFromEnv({})).toMatchObject({
      idle_timeout: DEFAULT_DB_IDLE_TIMEOUT_SEC,
      max_lifetime: DEFAULT_DB_MAX_LIFETIME_SEC,
    });
    expect(DEFAULT_DB_IDLE_TIMEOUT_SEC).toBeGreaterThan(0);
    // Must stay at or below the heartbeat tick cadence, or the pool never drains.
    expect(DEFAULT_DB_IDLE_TIMEOUT_SEC).toBeLessThanOrEqual(30);
  });

  it("honours env overrides", () => {
    expect(
      driverOptionsFromEnv({
        PAPERCLIP_DB_IDLE_TIMEOUT_SEC: "45",
        PAPERCLIP_DB_MAX_LIFETIME_SEC: "600",
      }),
    ).toMatchObject({ idle_timeout: 45, max_lifetime: 600 });
  });

  it("allows 0 to disable either timer", () => {
    // postgres.js `timer()` treats idle 0 as "no timer": never-close behaviour.
    // max_lifetime 0 omits the key, restoring the driver's jittered default.
    expect(driverOptionsFromEnv({ PAPERCLIP_DB_IDLE_TIMEOUT_SEC: "0" }).idle_timeout).toBe(0);
    expect(driverOptionsFromEnv({ PAPERCLIP_DB_MAX_LIFETIME_SEC: "0" })).not.toHaveProperty(
      "max_lifetime",
    );
  });

  it("falls back to defaults on blank or invalid values", () => {
    expect(driverOptionsFromEnv({ PAPERCLIP_DB_IDLE_TIMEOUT_SEC: "  " }).idle_timeout).toBe(
      DEFAULT_DB_IDLE_TIMEOUT_SEC,
    );
    expect(driverOptionsFromEnv({ PAPERCLIP_DB_MAX_LIFETIME_SEC: "nope" }).max_lifetime).toBe(
      DEFAULT_DB_MAX_LIFETIME_SEC,
    );
    expect(driverOptionsFromEnv({ PAPERCLIP_DB_MAX_LIFETIME_SEC: "-5" }).max_lifetime).toBe(
      DEFAULT_DB_MAX_LIFETIME_SEC,
    );
  });

  it("prefers upstream DATABASE_IDLE_TIMEOUT_SECONDS over the fork default", () => {
    expect(driverOptionsFromEnv({ DATABASE_IDLE_TIMEOUT_SECONDS: "45" }).idle_timeout).toBe(45);
  });
});
