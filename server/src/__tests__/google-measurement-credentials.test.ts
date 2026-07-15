import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("../services/google-measurement.py", import.meta.url));
const harness = `
import importlib.util, json, os, sys, types
sys.dont_write_bytecode = True
class Credentials:
    def __init__(self, **kwargs): self.kwargs = kwargs
google = types.ModuleType("google")
oauth2 = types.ModuleType("google.oauth2")
credentials = types.ModuleType("google.oauth2.credentials")
credentials.Credentials = Credentials
sys.modules.update({"google": google, "google.oauth2": oauth2, "google.oauth2.credentials": credentials})
spec = importlib.util.spec_from_file_location("measurement", ${JSON.stringify(scriptPath)})
measurement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(measurement)
try:
    result = measurement.ga4_credentials()
    print(json.dumps({"mode": "oauth", "scopes": result.kwargs["scopes"], "refresh": result.kwargs["refresh_token"]}))
except RuntimeError as error:
    print(json.dumps({"error": str(error)}))
`;

function ga4Credentials(env: Record<string, string>) {
  return JSON.parse(execFileSync("python3", ["-c", harness], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  }));
}

describe("GA4 credential modes", () => {
  it("uses the existing Ads OAuth tuple with analytics.readonly", () => {
    expect(ga4Credentials({
      GOOGLE_ADS_CLIENT_ID: "client-id",
      GOOGLE_ADS_CLIENT_SECRET: "client-secret",
      GOOGLE_ADS_REFRESH_TOKEN: "refresh-token",
    })).toEqual({ mode: "oauth", scopes: ["https://www.googleapis.com/auth/analytics.readonly"], refresh: "refresh-token" });
  });

  it("rejects mixed ADC and OAuth modes", () => {
    expect(ga4Credentials({
      GOOGLE_APPLICATION_CREDENTIALS: "/server/account.json",
      GOOGLE_ADS_CLIENT_ID: "client-id",
      GOOGLE_ADS_CLIENT_SECRET: "client-secret",
      GOOGLE_ADS_REFRESH_TOKEN: "refresh-token",
    })).toEqual({ error: "GA4 credential modes are mutually exclusive" });
  });
});
