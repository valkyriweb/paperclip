import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { listModels, resolveSessionKey } from "./execute.js";

async function createModelGateway(models: unknown[]) {
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-1" } }));
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { id: string; method: string };
      if (frame.method === "connect") {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 3 } }));
        return;
      }
      if (frame.method === "models.list") {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { models } }));
      }
    });
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("missing test gateway address");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

describe("listModels", () => {
  it("loads configured OpenClaw gateway models as provider/model ids", async () => {
    const gateway = await createModelGateway([
      { provider: "claude-bridge", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { key: "openai-codex/gpt-5.2", name: "GPT-5.2 Codex" },
      { provider: "openai-codex", id: "gpt-5.2", name: "Duplicate" },
      { id: "missing-provider" },
    ]);

    try {
      await expect(listModels({ adapterConfig: { url: gateway.url, disableDeviceAuth: true } })).resolves.toEqual([
        {
          id: "claude-bridge/claude-sonnet-4-6",
          label: "Claude Sonnet 4.6 (claude-bridge/claude-sonnet-4-6)",
        },
        {
          id: "openai-codex/gpt-5.2",
          label: "GPT-5.2 Codex (openai-codex/gpt-5.2)",
        },
      ]);
    } finally {
      await gateway.close();
    }
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
