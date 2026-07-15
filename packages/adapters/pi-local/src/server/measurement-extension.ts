// JSON Schema is deliberately dependency-free: Pi validates it before invoking this tool.
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "report", "startDate", "endDate"],
  properties: {
    provider: { type: "string", enum: ["google_ads", "ga4"] },
    report: { type: "string", enum: ["summary", "campaigns", "acquisition"] },
    startDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    endDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    rowLimit: { type: "integer", minimum: 1, maximum: 500 },
  },
};

function safeError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(/(access_token|refresh_token|client_secret|developer_token|authorization)[=:]\S+/gi, "$1=***REDACTED***");
}

export default function measurementExtension(pi: { registerTool: (tool: unknown) => void }) {
  pi.registerTool({
    name: "measurement_query",
    label: "Measurement Query",
    description: "Read a bounded Google Ads or GA4 report. It accepts only fixed reports, a maximum 31-day date range, and at most 500 rows; it never accepts GAQL, credentials, or mutations.",
    parameters: schema,
    async execute(_id: string, params: unknown, signal?: AbortSignal) {
      const apiUrl = process.env.PAPERCLIP_API_URL?.replace(/\/+$/, "");
      const apiKey = process.env.PAPERCLIP_API_KEY;
      const companyId = process.env.PAPERCLIP_COMPANY_ID;
      if (!apiUrl || !apiKey || !companyId) throw new Error("Paperclip measurement runtime is unavailable");
      const response = await fetch(`${apiUrl}/api/companies/${encodeURIComponent(companyId)}/measurement/query`,  {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(process.env.PAPERCLIP_RUN_ID ? { "X-Paperclip-Run-Id": process.env.PAPERCLIP_RUN_ID } : {}),
        },
        body: JSON.stringify(params),
        signal,
      });
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) throw new Error(safeError(body?.error ?? "Measurement query failed"));
      const text = JSON.stringify(body);
      return { content: [{ type: "text", text: text.length > 50_000 ? `${text.slice(0, 50_000)}\n[Output truncated]` : text }], details: {} };
    },
  });
}
