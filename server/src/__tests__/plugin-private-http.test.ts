import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHostServices } from "../services/plugin-host-services.js";

const ENV_KEY = "PAPERCLIP_PLUGIN_76616C6B7972697765622E74656C6C6D65_PRIVATE_HTTP_ORIGINS";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
        clear: vi.fn(),
      };
    },
  } as any;
}

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("plugin private HTTP origins", () => {
  it("blocks private targets unless the operator allowlists the exact plugin origin", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address unavailable");
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      const blocked = buildHostServices(
        {} as never,
        "plugin-record-id",
        "valkyriweb.tellme",
        createEventBusStub(),
      );
      await expect(blocked.http.fetch({ url: `${origin}/readyz` })).rejects.toThrow(/private\/reserved/i);
      blocked.dispose();

      process.env[ENV_KEY] = origin;
      const allowed = buildHostServices(
        {} as never,
        "plugin-record-id",
        "valkyriweb.tellme",
        createEventBusStub(),
      );
      await expect(allowed.http.fetch({ url: `${origin}/readyz` })).resolves.toMatchObject({ status: 200 });
      allowed.dispose();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
