import { describe, expect, it } from "vitest";
import { createMeasurementFacade, measurementRequestSchema } from "../services/measurement.js";

const companyId = "11111111-1111-1111-1111-111111111111";
const request = { provider: "google_ads", report: "summary", startDate: "2026-01-01", endDate: "2026-01-07", rowLimit: 10 };
const configuredEnv = { PAPERCLIP_MEASUREMENT_CONFIG: JSON.stringify({ companies: { [companyId]: { googleAdsCustomerIds: ["123"], googleAdsLoginCustomerId: "456" } } }) };
const validResponse = {
  provider: "google_ads" as const,
  report: "summary" as const,
  startDate: "2026-01-01",
  endDate: "2026-01-07",
  columns: ["date", "impressions", "clicks", "cost", "conversions", "conversionValue"],
  rows: [{ date: "2026-01-01", impressions: 10, clicks: 3, cost: 1, conversions: 1, conversionValue: 2 }],
  rowCount: 1,
};

describe("measurement facade", () => {
  it("rejects arbitrary reports, overlong ranges, and unsupported provider/report pairs", () => {
    expect(() => measurementRequestSchema.parse({ ...request, gaql: "SELECT *" })).toThrow();
    expect(() => measurementRequestSchema.parse({ ...request, endDate: "2026-03-01" })).toThrow("31 days");
    expect(() => measurementRequestSchema.parse({ ...request, startDate: "2026-02-30" })).toThrow("real ISO");
    expect(() => measurementRequestSchema.parse({ ...request, provider: "ga4", report: "campaigns" })).toThrow("only available");
  });

  it("constructs without configuration and fails closed only when queried", async () => {
    const facade = createMeasurementFacade({ env: {} });
    await expect(facade.query(companyId, request)).rejects.toThrow("not configured");
    const unassigned = createMeasurementFacade({ env: { PAPERCLIP_MEASUREMENT_CONFIG: JSON.stringify({ companies: {} }) } });
    await expect(unassigned.query(companyId, request)).rejects.toThrow("not configured for this company");
  });

  it("passes only the selected company allowlist and manager login customer ID", async () => {
    let providerEnv: NodeJS.ProcessEnv | undefined;
    const facade = createMeasurementFacade({ env: configuredEnv, run: async (_request, env) => {
      providerEnv = env;
      return validResponse;
    } });
    await expect(facade.query(companyId, request)).resolves.toEqual(validResponse);
    expect(providerEnv).toMatchObject({
      PAPERCLIP_MEASUREMENT_ALLOWED_IDS: '["123"]',
      PAPERCLIP_MEASUREMENT_GOOGLE_ADS_LOGIN_CUSTOMER_ID: "456",
    });
  });

  it("rejects mismatched date ranges, row counts, and provider-controlled columns", async () => {
    for (const response of [
      { ...validResponse, startDate: "2026-01-02" },
      { ...validResponse, rowCount: 2 },
      { ...validResponse, columns: ["developerToken"], rows: [{ developerToken: "secret" }] },
    ]) {
      const facade = createMeasurementFacade({ env: configuredEnv, run: async () => response });
      await expect(facade.query(companyId, request)).rejects.toThrow("invalid response");
    }
  });

  it("redacts credential-like provider failures", async () => {
    const facade = createMeasurementFacade({ env: configuredEnv, run: async () => { throw new Error("refresh_token=secret-value"); } });
    await expect(facade.query(companyId, request)).rejects.toThrow("refresh_token=***REDACTED***");
  });
});
