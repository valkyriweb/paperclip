import { describe, expect, it } from "vitest";
import {
  buildAgentParams,
  classifyGatewayFailure,
  connectRetryDelayMs,
  DEFAULT_CONNECT_TIMEOUT_MS,
  resolveConnectTimeoutMs,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  resolveClaimedApiKeyPath,
  resolveSessionKey,
} from "./execute.js";

describe("openclaw gateway protocol", () => {
  it("negotiates gateway protocol v4 while accepting v3 rollback", () => {
    expect(MIN_PROTOCOL_VERSION).toBe(3);
    expect(PROTOCOL_VERSION).toBe(4);
  });
});

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});

describe("buildAgentParams", () => {
  it("strips root-level paperclip fields from gateway agent params", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          text: "old text",
          paperclip: { stale: true },
          keep: "value",
        },
        message: "wake text",
        sessionKey: "agent:meridian:paperclip:issue:issue-456",
        runId: "run-123",
        configuredAgentId: "meridian",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      keep: "value",
      message: "wake text",
      sessionKey: "agent:meridian:paperclip:issue:issue-456",
      idempotencyKey: "run-123",
      agentId: "meridian",
      timeout: 30_000,
    });
  });

  it("preserves an explicit agentId and timeout from the payload template", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          agentId: "template-agent",
          timeout: 5_000,
        },
        message: "wake text",
        sessionKey: "paperclip",
        runId: "run-123",
        configuredAgentId: "configured-agent",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      agentId: "template-agent",
      timeout: 5_000,
      message: "wake text",
      sessionKey: "paperclip",
      idempotencyKey: "run-123",
    });
  });
});

describe("resolveConnectTimeoutMs", () => {
  it("defaults to 15s when no explicit config is present", () => {
    expect(resolveConnectTimeoutMs({}, 900_000)).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
  });

  it("still clamps to the run timeout when that is smaller than the default", () => {
    expect(resolveConnectTimeoutMs({}, 5_000)).toBe(5_000);
  });

  it("uses 10s when the run timeout is disabled", () => {
    expect(resolveConnectTimeoutMs({}, 0)).toBe(10_000);
  });

  it("lets an operator raise the connect timeout past the old 15s hard cap", () => {
    expect(resolveConnectTimeoutMs({ connectTimeoutMs: 60_000 }, 900_000)).toBe(60_000);
    expect(resolveConnectTimeoutMs({ connectTimeoutMs: "45000" }, 0)).toBe(45_000);
  });
});

describe("classifyGatewayFailure", () => {
  it("classifies run overruns as timeouts that are not retried", () => {
    const run = classifyGatewayFailure("OpenClaw gateway run timed out after 900000ms");
    expect(run).toMatchObject({ phase: "run", timedOut: true, retryable: false });
    expect(run.errorCode).toBe("openclaw_gateway_timeout");

    const wait = classifyGatewayFailure("gateway request timeout (agent.wait)");
    expect(wait).toMatchObject({ phase: "run", timedOut: true, retryable: false });
  });

  it("classifies connect and submission timeouts distinctly from run overruns", () => {
    for (const message of [
      "gateway websocket open timeout",
      "gateway connect challenge timeout",
      "gateway request timeout (connect)",
      "gateway request timeout (agent)",
    ]) {
      const result = classifyGatewayFailure(message);
      expect(result, message).toMatchObject({
        phase: "connect",
        timedOut: false,
        retryable: true,
        errorCode: "openclaw_gateway_connect_timeout",
      });
    }
  });

  it("classifies transport errors as retryable connect failures", () => {
    for (const message of [
      "connect ECONNREFUSED 10.42.0.1:18789",
      "read ECONNRESET",
      "socket hang up",
      "gateway closed before open (1006): ",
    ]) {
      expect(classifyGatewayFailure(message), message).toMatchObject({
        phase: "connect",
        retryable: true,
        timedOut: false,
      });
    }
  });

  it("leaves unrelated failures as plain request failures", () => {
    expect(classifyGatewayFailure("pairing required")).toMatchObject({
      phase: "other",
      timedOut: false,
      retryable: false,
      errorCode: "openclaw_gateway_request_failed",
    });
  });
});

describe("connectRetryDelayMs", () => {
  it("backs off exponentially and stays bounded", () => {
    expect(connectRetryDelayMs(1)).toBe(2_000);
    expect(connectRetryDelayMs(2)).toBe(4_000);
    expect(connectRetryDelayMs(3)).toBe(8_000);
    expect(connectRetryDelayMs(10)).toBe(30_000);

describe("resolveClaimedApiKeyPath", () => {
  const DEFAULT_PATH = "~/.openclaw/workspace/paperclip-claimed-api-key.json";

  it("returns the configured per-agent path when set", () => {
    expect(
      resolveClaimedApiKeyPath("~/.openclaw/workspace/paperclip-keys/happy.json"),
    ).toBe("~/.openclaw/workspace/paperclip-keys/happy.json");
  });

  it("falls back to the shared default when value is empty", () => {
    expect(resolveClaimedApiKeyPath("")).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath("   ")).toBe(DEFAULT_PATH);
  });

  it("falls back to the shared default when value is missing", () => {
    expect(resolveClaimedApiKeyPath(undefined)).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath(null)).toBe(DEFAULT_PATH);
  });

  it("falls back to the shared default when value is not a string", () => {
    expect(resolveClaimedApiKeyPath(42)).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath({})).toBe(DEFAULT_PATH);
  });
});
