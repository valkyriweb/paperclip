import { afterEach, describe, expect, it, vi } from "vitest";
import measurementExtension from "./measurement-extension.js";

type RegisteredTool = { execute: (_id: string, params: unknown, signal?: AbortSignal) => Promise<unknown> };
const originalEnv = { ...process.env };

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe("measurement Pi extension", () => {
  it("uses PAPERCLIP_API_URL as the API root and includes the /api contract prefix", async () => {
    process.env.PAPERCLIP_API_URL = "http://paperclip.test/";
    process.env.PAPERCLIP_API_KEY = "agent-key";
    process.env.PAPERCLIP_COMPANY_ID = "company-1";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rowCount: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let tool: RegisteredTool | undefined;
    measurementExtension({ registerTool: (registered) => { tool = registered as RegisteredTool; } });

    await tool!.execute("call-1", { provider: "ga4", report: "summary", startDate: "2026-01-01", endDate: "2026-01-02" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/companies/company-1/measurement/query",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer agent-key" }) }),
    );
  });
});
