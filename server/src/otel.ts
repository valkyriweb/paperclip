import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

/**
 * Resource attributes Paperclip stamps on every OTLP signal.
 *
 * The contract lives in agent-system/TELEMETRY-SCHEMA.md (shared across Paperclip,
 * Multica, the agent CLIs, and the review agents). Each value falls back to the
 * schema default and can be overridden per-deployment through its environment
 * variable — nothing here is hardcoded to a single cluster.
 */
export function buildResourceAttributes(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    'observability.domain': 'agent',
    'service.namespace': env.OTEL_SERVICE_NAMESPACE ?? 'paperclip',
    'service.name': env.OTEL_SERVICE_NAME ?? 'paperclip-server',
    'deployment.environment': env.PAPERCLIP_DEPLOYMENT_ENV ?? 'lue-kube',
    'telemetry.source': 'native_otlp',
    'agent.product': 'paperclip',
    'agent.surface': env.PAPERCLIP_AGENT_SURFACE ?? 'k8s',
    'agent.role': env.PAPERCLIP_AGENT_ROLE ?? 'executive',
  };
}

/** Serialize attributes into the `key=value,key=value` form OTEL_RESOURCE_ATTRIBUTES expects. */
export function serializeResourceAttributes(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

/**
 * Seed OTEL_RESOURCE_ATTRIBUTES / OTEL_SERVICE_NAME so the SDK's env resource
 * detector emits the schema attributes. Any operator-supplied
 * OTEL_RESOURCE_ATTRIBUTES is appended last so it wins on key collisions.
 */
export function applyResourceAttributes(env: NodeJS.ProcessEnv = process.env): void {
  const attrs = buildResourceAttributes(env);
  const serialized = serializeResourceAttributes(attrs);
  const operatorSupplied = env.OTEL_RESOURCE_ATTRIBUTES?.trim();
  env.OTEL_RESOURCE_ATTRIBUTES = operatorSupplied
    ? `${serialized},${operatorSupplied}`
    : serialized;
  env.OTEL_SERVICE_NAME = attrs['service.name'];
}

if (process.env.OTEL_LOG_LEVEL?.toLowerCase() === 'debug') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  applyResourceAttributes();

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 30_000,
    }),
    instrumentations: [getNodeAutoInstrumentations({
      // fs instrumentation disabled — too noisy
      '@opentelemetry/instrumentation-fs': { enabled: false },
    })],
  });
  sdk.start();

  const shutdown = () => sdk.shutdown().catch(() => {}).finally(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
