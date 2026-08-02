import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { measurementRoutes } from "../routes/measurement.js";

const companyId = "11111111-1111-1111-1111-111111111111";
const body = { provider: "ga4", report: "summary", startDate: "2026-01-01", endDate: "2026-01-02" };
const originalConfig = process.env.PAPERCLIP_MEASUREMENT_CONFIG;

afterEach(() => {
  if (originalConfig === undefined) delete process.env.PAPERCLIP_MEASUREMENT_CONFIG;
  else process.env.PAPERCLIP_MEASUREMENT_CONFIG = originalConfig;
});

function appFor(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", measurementRoutes());
  app.use(errorHandler);
  return app;
}

describe("measurement route", () => {
  it("starts without optional configuration and fails closed at the endpoint", async () => {
    delete process.env.PAPERCLIP_MEASUREMENT_CONFIG;
    const app = appFor({ type: "agent", companyId, agentId: "agent-1", source: "agent_key" });
    const response = await request(app).post(`/api/companies/${companyId}/measurement/query`).send(body);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "Measurement is unavailable" });
  });

  it("rejects board callers and agents from another company before provider access", async () => {
    process.env.PAPERCLIP_MEASUREMENT_CONFIG = "malformed";
    const board = await request(appFor({ type: "board", companyIds: [companyId], source: "session", isInstanceAdmin: false }))
      .post(`/api/companies/${companyId}/measurement/query`).send(body);
    expect(board.status).toBe(403);
    expect(board.body.error).toMatch(/Agent authentication/);

    const otherCompany = await request(appFor({ type: "agent", companyId: "other-company", agentId: "agent-1", source: "agent_key" }))
      .post(`/api/companies/${companyId}/measurement/query`).send(body);
    expect(otherCompany.status).toBe(403);
    expect(otherCompany.body.error).toMatch(/another company/);
  });
});
