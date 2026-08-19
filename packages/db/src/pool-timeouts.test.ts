import { describe, expect, it } from "vitest";
import {
  DEFAULT_DB_IDLE_TIMEOUT_SEC,
  DEFAULT_DB_MAX_LIFETIME_SEC,
  resolveDbPoolTimeouts,
} from "./client.js";

describe("resolveDbPoolTimeouts", () => {
  it("bounds idle connections by default so smart shutdown is not blocked", () => {
    expect(resolveDbPoolTimeouts({})).toEqual({
      idle_timeout: DEFAULT_DB_IDLE_TIMEOUT_SEC,
      max_lifetime: DEFAULT_DB_MAX_LIFETIME_SEC,
    });
    expect(DEFAULT_DB_IDLE_TIMEOUT_SEC).toBeGreaterThan(0);
    // Must stay at or below the heartbeat tick cadence, or the pool never drains.
    expect(DEFAULT_DB_IDLE_TIMEOUT_SEC).toBeLessThanOrEqual(30);
  });

  it("honours env overrides", () => {
    expect(
      resolveDbPoolTimeouts({
        PAPERCLIP_DB_IDLE_TIMEOUT_SEC: "45",
        PAPERCLIP_DB_MAX_LIFETIME_SEC: "600",
      }),
    ).toEqual({ idle_timeout: 45, max_lifetime: 600 });
  });

  it("allows 0 to disable either timer", () => {
    // postgres.js `timer()` treats 0 as "no timer": idle 0 restores the never-close
    // behaviour, max_lifetime 0 falls back to no forced recycle.
    expect(resolveDbPoolTimeouts({ PAPERCLIP_DB_IDLE_TIMEOUT_SEC: "0" }).idle_timeout).toBe(0);
    expect(resolveDbPoolTimeouts({ PAPERCLIP_DB_MAX_LIFETIME_SEC: "0" }).max_lifetime).toBe(0);
  });

  it("falls back to defaults on blank or invalid values", () => {
    expect(resolveDbPoolTimeouts({ PAPERCLIP_DB_IDLE_TIMEOUT_SEC: "  " }).idle_timeout).toBe(
      DEFAULT_DB_IDLE_TIMEOUT_SEC,
    );
    expect(resolveDbPoolTimeouts({ PAPERCLIP_DB_MAX_LIFETIME_SEC: "nope" }).max_lifetime).toBe(
      DEFAULT_DB_MAX_LIFETIME_SEC,
    );
    expect(resolveDbPoolTimeouts({ PAPERCLIP_DB_MAX_LIFETIME_SEC: "-5" }).max_lifetime).toBe(
      DEFAULT_DB_MAX_LIFETIME_SEC,
    );
  });
});
