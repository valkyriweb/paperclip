import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

type WaitStep = "timeout" | "ok" | "drop";

interface ScriptedGatewayOptions {
  waitScript: WaitStep[];
  // Per-connection (0-based) behavior. "drop" closes the socket right after connect to
  // simulate a gateway restart during the connect handshake.
  connectionMode?: (index: number) => "normal" | "drop";
  timeoutDelayMs?: number;
  // Tool `item` events emitted on the first agent.wait, to drive the loop guard.
  emitItemsOnWait?: Array<{ name: string; title: string }>;
  // What to send after emitting items: a wait step, or undefined to hold (no response).
  respondAfterItems?: WaitStep;
}

function createScriptedGateway(opts: ScriptedGatewayOptions) {
  let connectionIndex = -1;
  let waitCursor = 0;
  let emittedItems = false;
  const wss = new WebSocketServer({ port: 0 });

  wss.on("connection", (ws: WebSocket) => {
    connectionIndex += 1;
    const idx = connectionIndex;
    const mode = opts.connectionMode?.(idx) ?? "normal";
    if (mode === "drop") {
      ws.close(1012, "service restart");
      return;
    }

    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: `nonce-${idx}` } }));

    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { id: string; method: string };
      if (frame.method === "connect") {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 4 } }));
        return;
      }
      if (frame.method === "agent") {
        ws.send(
          JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { status: "accepted", runId: "run-remote-1" } }),
        );
        return;
      }
      if (frame.method === "agent.wait") {
        if (opts.emitItemsOnWait && !emittedItems) {
          emittedItems = true;
          for (const item of opts.emitItemsOnWait) {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "agent",
                payload: {
                  runId: "run-remote-1",
                  stream: "item",
                  data: { kind: "tool", name: item.name, title: item.title, phase: "start" },
                },
              }),
            );
          }
          if (!opts.respondAfterItems) return; // hold: let the loop guard abort
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload:
                opts.respondAfterItems === "ok"
                  ? { status: "ok", payloads: [{ text: "done" }] }
                  : { status: opts.respondAfterItems },
            }),
          );
          return;
        }
        const step = opts.waitScript[Math.min(waitCursor, opts.waitScript.length - 1)];
        waitCursor += 1;
        if (step === "drop") {
          ws.close(1012, "service restart");
          return;
        }
        if (step === "timeout") {
          setTimeout(() => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { status: "timeout" } }));
            }
          }, opts.timeoutDelayMs ?? 25);
          return;
        }
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { status: "ok", payloads: [{ text: "done" }] },
          }),
        );
      }
    });
  });

  return {
    ready: new Promise<void>((resolve) => wss.once("listening", resolve)),
    url: () => {
      const address = wss.address();
      if (!address || typeof address === "string") throw new Error("missing test gateway address");
      return `ws://127.0.0.1:${address.port}`;
    },
    connections: () => connectionIndex + 1,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

function buildCtx(url: string, config: Record<string, unknown>): AdapterExecutionContext {
  const logs: string[] = [];
  return {
    runId: "run-local-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Tester" },
    runtime: {},
    config: {
      url,
      disableDeviceAuth: true,
      retryBackoffMs: 5,
      retryBackoffCapMs: 20,
      ...config,
    },
    context: {},
    onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
      logs.push(chunk);
    },
  } as unknown as AdapterExecutionContext;
}

describe("execute resilience", () => {
  it("long-polls past a wait slice that returns timeout while the run is still live", async () => {
    const gateway = createScriptedGateway({ waitScript: ["timeout", "timeout", "ok"] });
    await gateway.ready;
    try {
      const result = await execute(buildCtx(gateway.url(), { waitTimeoutMs: 30_000 }));
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.summary).toBe("done");
    } finally {
      await gateway.close();
    }
  });

  it("reconnects and resumes agent.wait after a mid-run websocket drop", async () => {
    const gateway = createScriptedGateway({ waitScript: ["drop", "ok"] });
    await gateway.ready;
    try {
      const result = await execute(buildCtx(gateway.url(), { waitTimeoutMs: 30_000 }));
      expect(result.exitCode).toBe(0);
      expect(result.summary).toBe("done");
      // First connection submitted+waited (dropped); second reconnected to resume the wait.
      expect(gateway.connections()).toBeGreaterThanOrEqual(2);
    } finally {
      await gateway.close();
    }
  });

  it("retries a transient connect failure before submitting the run", async () => {
    const gateway = createScriptedGateway({
      waitScript: ["ok"],
      connectionMode: (index) => (index === 0 ? "drop" : "normal"),
    });
    await gateway.ready;
    try {
      const result = await execute(buildCtx(gateway.url(), { waitTimeoutMs: 30_000 }));
      expect(result.exitCode).toBe(0);
      expect(result.summary).toBe("done");
      expect(gateway.connections()).toBeGreaterThanOrEqual(2);
    } finally {
      await gateway.close();
    }
  });

  it("aborts a run that busy-loops the same tool call (loop guard)", async () => {
    const gateway = createScriptedGateway({
      waitScript: ["ok"],
      emitItemsOnWait: Array.from({ length: 15 }, () => ({ name: "exec", title: "cat /tmp/pc_out.txt" })),
      // hold after emitting: the guard must abort before any wait response
    });
    await gateway.ready;
    try {
      const result = await execute(buildCtx(gateway.url(), { waitTimeoutMs: 8_000 }));
      expect(result.exitCode).toBe(1);
      expect(result.timedOut).toBe(false);
      expect(result.errorCode).toBe("openclaw_gateway_loop_detected");
    } finally {
      await gateway.close();
    }
  });

  it("does not false-positive on distinct tool calls", async () => {
    const gateway = createScriptedGateway({
      waitScript: ["ok"],
      emitItemsOnWait: Array.from({ length: 12 }, (_v, i) => ({ name: "exec", title: `step-${i}` })),
      respondAfterItems: "ok",
    });
    await gateway.ready;
    try {
      const result = await execute(buildCtx(gateway.url(), { waitTimeoutMs: 30_000 }));
      expect(result.exitCode).toBe(0);
      expect(result.summary).toBe("done");
    } finally {
      await gateway.close();
    }
  });

  it("fails open (no abort) when tool items carry no title to discriminate on", async () => {
    const gateway = createScriptedGateway({
      waitScript: ["ok"],
      // Same tool name, no title: must NOT collapse to one signature and trip the guard.
      emitItemsOnWait: Array.from({ length: 12 }, () => ({ name: "read", title: "" })),
      respondAfterItems: "ok",
    });
    await gateway.ready;
    try {
      const result = await execute(buildCtx(gateway.url(), { waitTimeoutMs: 30_000 }));
      expect(result.exitCode).toBe(0);
      expect(result.summary).toBe("done");
    } finally {
      await gateway.close();
    }
  });

  it("returns a wait timeout only after the overall deadline elapses", async () => {
    const gateway = createScriptedGateway({ waitScript: ["timeout"], timeoutDelayMs: 60 });
    await gateway.ready;
    try {
      const result = await execute(buildCtx(gateway.url(), { waitTimeoutMs: 500 }));
      expect(result.exitCode).toBe(1);
      expect(result.timedOut).toBe(true);
      expect(result.errorCode).toBe("openclaw_gateway_wait_timeout");
    } finally {
      await gateway.close();
    }
  });
});
