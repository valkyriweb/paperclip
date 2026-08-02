import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const providerSchema = z.enum(["google_ads", "ga4"]);
const reportSchema = z.enum(["summary", "campaigns", "acquisition"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MEASUREMENT_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_OUTPUT_BYTES = 1_000_000;

function isValidIsoDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export const measurementRequestSchema = z.object({
  provider: providerSchema,
  report: reportSchema,
  startDate: dateSchema,
  endDate: dateSchema,
  rowLimit: z.number().int().min(1).max(500).default(100),
}).strict().superRefine((value, ctx) => {
  const start = new Date(`${value.startDate}T00:00:00Z`);
  const end = new Date(`${value.endDate}T00:00:00Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (!isValidIsoDate(value.startDate) || !isValidIsoDate(value.endDate)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "date values must be real ISO calendar dates" });
  } else if (start > end) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "startDate must be on or before endDate" });
  }
  if (end > today) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "date range cannot include future dates" });
  if ((end.valueOf() - start.valueOf()) / 86_400_000 > 31) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "date range cannot exceed 31 days" });
  }
  if (value.provider === "google_ads" && value.report === "acquisition") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "acquisition is only available for ga4" });
  }
  if (value.provider === "ga4" && value.report === "campaigns") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "campaigns is only available for google_ads" });
  }
});

export type MeasurementRequest = z.infer<typeof measurementRequestSchema>;
const measurementResponseSchema = z.object({
  provider: providerSchema,
  report: reportSchema,
  startDate: dateSchema,
  endDate: dateSchema,
  columns: z.array(z.string().min(1)),
  rows: z.array(z.record(z.union([z.string(), z.number(), z.null()]))),
  rowCount: z.number().int().nonnegative(),
}).strict();
export type MeasurementResponse = z.infer<typeof measurementResponseSchema>;

const runtimeConfigSchema = z.object({
  companies: z.record(z.object({
    googleAdsCustomerIds: z.array(z.string().regex(/^\d+$/)).min(1).optional(),
    googleAdsLoginCustomerId: z.string().regex(/^\d+$/).optional(),
    ga4PropertyIds: z.array(z.string().regex(/^\d+$/)).min(1).optional(),
  }).strict()),
}).strict();

export type MeasurementRuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export function readMeasurementRuntimeConfig(env: NodeJS.ProcessEnv = process.env): MeasurementRuntimeConfig {
  const raw = env.PAPERCLIP_MEASUREMENT_CONFIG;
  if (!raw) throw new Error("Measurement is not configured");
  try {
    return runtimeConfigSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("Measurement configuration is invalid");
  }
}

export function sanitizeMeasurementError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.replace(/(access_token|refresh_token|client_secret|developer_token|authorization)[=:]\S+/gi, "$1=***REDACTED***"));
}

export type MeasurementRunner = (
  request: MeasurementRequest,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) => Promise<MeasurementResponse>;

const reportColumns: Record<MeasurementRequest["provider"], Partial<Record<MeasurementRequest["report"], string[]>>> = {
  google_ads: {
    summary: ["date", "impressions", "clicks", "cost", "conversions", "conversionValue"],
    campaigns: ["date", "campaign", "impressions", "clicks", "cost", "conversions", "conversionValue"],
  },
  ga4: {
    summary: ["date", "sessions", "totalUsers", "engagedSessions", "conversions", "totalRevenue"],
    acquisition: ["date", "sessionSource", "sessionMedium", "sessions", "totalUsers", "engagedSessions", "conversions", "totalRevenue"],
  },
};

function assertCoherentResponse(response: MeasurementResponse, request: MeasurementRequest): void {
  const expectedColumns = reportColumns[request.provider][request.report]!;
  if (
    response.provider !== request.provider ||
    response.report !== request.report ||
    response.startDate !== request.startDate ||
    response.endDate !== request.endDate ||
    response.rows.length > request.rowLimit ||
    response.rowCount !== response.rows.length ||
    response.columns.length !== expectedColumns.length ||
    response.columns.some((column, index) => column !== expectedColumns[index]) ||
    response.rows.some((row) => {
      const keys = Object.keys(row);
      return keys.length !== expectedColumns.length || keys.some((key) => !expectedColumns.includes(key));
    })
  ) {
    throw new Error("Measurement provider returned an invalid response");
  }
}

export function createMeasurementFacade(input: { env?: NodeJS.ProcessEnv; run?: MeasurementRunner } = {}) {
  const env = input.env ?? process.env;
  const run = input.run ?? runGoogleMeasurement;
  return {
    async query(companyId: string, rawRequest: unknown, signal?: AbortSignal): Promise<MeasurementResponse> {
      const request = measurementRequestSchema.parse(rawRequest);
      const config = readMeasurementRuntimeConfig(env); // Optional feature: parse only when invoked.
      const allowed = config.companies[companyId];
      if (!allowed) throw new Error("Measurement is not configured for this company");
      if (request.provider === "google_ads" && !allowed.googleAdsCustomerIds?.length) {
        throw new Error("Google Ads measurement is not configured for this company");
      }
      if (request.provider === "ga4" && !allowed.ga4PropertyIds?.length) {
        throw new Error("GA4 measurement is not configured for this company");
      }
      try {
        const response = measurementResponseSchema.parse(await run(request, {
          ...env,
          PAPERCLIP_MEASUREMENT_ALLOWED_IDS: JSON.stringify(
            request.provider === "google_ads" ? allowed.googleAdsCustomerIds : allowed.ga4PropertyIds,
          ),
          ...(allowed.googleAdsLoginCustomerId
            ? { PAPERCLIP_MEASUREMENT_GOOGLE_ADS_LOGIN_CUSTOMER_ID: allowed.googleAdsLoginCustomerId }
            : {}),
        }, signal));
        assertCoherentResponse(response, request);
        return response;
      } catch (error) {
        throw sanitizeMeasurementError(error);
      }
    },
  };
}

export const runGoogleMeasurement: MeasurementRunner = async (request, env, signal) => {
  const script = fileURLToPath(new URL("./google-measurement.py", import.meta.url));
  const python = env.PAPERCLIP_MEASUREMENT_PYTHON?.trim() || "python3";
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { env: { ...env, PYTHONUNBUFFERED: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, result?: MeasurementResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const stop = (message: string) => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
      finish(new Error(message));
    };
    const abort = () => stop("Measurement provider request aborted");
    const timeout = setTimeout(() => stop("Measurement provider request timed out"), MEASUREMENT_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const append = (current: string, chunk: Buffer, stream: "stdout" | "stderr") => {
      if (Buffer.byteLength(current) + chunk.length > MAX_PROVIDER_OUTPUT_BYTES) {
        stop("Measurement provider response exceeded output limit");
        return current;
      }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk, "stdout"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk, "stderr"); });
    child.stdin.on("error", () => finish(new Error("Measurement provider request failed")));
    child.on("error", () => finish(new Error("Measurement provider request failed")));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error("Measurement provider request failed"));
      try { finish(undefined, measurementResponseSchema.parse(JSON.parse(stdout))); }
      catch { finish(new Error("Measurement provider returned an invalid response")); }
    });
    child.stdin.end(JSON.stringify(request));
  });
};
