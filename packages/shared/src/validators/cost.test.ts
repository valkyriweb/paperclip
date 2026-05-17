/**
 * Validator tests for createCostEventSchema. The schema gates every
 * cost-events POST from claude-bridge, pi-local heartbeat, the Multica
 * forwarder, the P4b watcher, and the Pi extension; loose validation lets
 * any one of those poison the dashboard for everyone.
 *
 * Substream: agent-system/PAPERCLIP-BUDGET-INTEGRATION.md G2 validator gate.
 */

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createCostEventSchema } from "./cost";

function valid() {
  return {
    agentId: randomUUID(),
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    inputTokens: 1000,
    outputTokens: 100,
    costCents: 5,
    occurredAt: new Date().toISOString(),
  };
}

describe("createCostEventSchema", () => {
  it("accepts a well-formed event", () => {
    expect(() => createCostEventSchema.parse(valid())).not.toThrow();
  });

  it("defaults biller to provider when omitted", () => {
    const parsed = createCostEventSchema.parse(valid());
    expect(parsed.biller).toBe("anthropic");
  });

  it("preserves an explicit biller when provided", () => {
    const parsed = createCostEventSchema.parse({
      ...valid(),
      biller: "claude-code",
    });
    expect(parsed.biller).toBe("claude-code");
  });

  describe("occurredAt future-bound guard", () => {
    it("accepts a timestamp 30 minutes in the future (clock-skew tolerance)", () => {
      const occurredAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      expect(() => createCostEventSchema.parse({ ...valid(), occurredAt })).not.toThrow();
    });

    it("rejects a timestamp 2 hours in the future", () => {
      const occurredAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      expect(() => createCostEventSchema.parse({ ...valid(), occurredAt })).toThrowError(
        /occurredAt must not be more than 1 hour in the future/,
      );
    });

    it("rejects a year-7000 timestamp (UNIX-seconds-as-millis bug)", () => {
      // emitter passed `new Date(Date.now()).toISOString()` after accidentally
      // computing now in seconds and forgetting the *1000 → multiplied later.
      const occurredAt = new Date(Date.now() * 1000).toISOString();
      expect(() => createCostEventSchema.parse({ ...valid(), occurredAt })).toThrow();
    });

    it("accepts a far-past timestamp (replay/backfill is legit)", () => {
      const occurredAt = "2024-01-01T00:00:00.000Z";
      expect(() => createCostEventSchema.parse({ ...valid(), occurredAt })).not.toThrow();
    });
  });

  describe("nonnegative bounds", () => {
    it("rejects negative inputTokens", () => {
      expect(() => createCostEventSchema.parse({ ...valid(), inputTokens: -1 })).toThrow();
    });

    it("rejects negative outputTokens", () => {
      expect(() => createCostEventSchema.parse({ ...valid(), outputTokens: -1 })).toThrow();
    });

    it("rejects negative costCents", () => {
      expect(() => createCostEventSchema.parse({ ...valid(), costCents: -1 })).toThrow();
    });
  });

  describe("required-field bounds", () => {
    it("rejects empty provider", () => {
      expect(() => createCostEventSchema.parse({ ...valid(), provider: "" })).toThrow();
    });

    it("rejects empty model", () => {
      expect(() => createCostEventSchema.parse({ ...valid(), model: "" })).toThrow();
    });

    it("rejects non-UUID agentId", () => {
      expect(() => createCostEventSchema.parse({ ...valid(), agentId: "not-a-uuid" })).toThrow();
    });
  });
});
