import { describe, expect, it } from "vitest";
import {
  applyResourceAttributes,
  buildResourceAttributes,
  serializeResourceAttributes,
} from "../otel.js";

describe("buildResourceAttributes", () => {
  it("emits the schema defaults when no overrides are set", () => {
    const attrs = buildResourceAttributes({});
    expect(attrs).toEqual({
      "observability.domain": "agent",
      "service.namespace": "paperclip",
      "service.name": "paperclip-server",
      "deployment.environment": "lue-kube",
      "telemetry.source": "native_otlp",
      "agent.product": "paperclip",
      "agent.surface": "k8s",
      "agent.role": "executive",
    });
  });

  it("honors per-attribute environment overrides", () => {
    const attrs = buildResourceAttributes({
      OTEL_SERVICE_NAMESPACE: "paperclip-staging",
      OTEL_SERVICE_NAME: "paperclip-canary",
      PAPERCLIP_DEPLOYMENT_ENV: "macbook",
      PAPERCLIP_AGENT_SURFACE: "cli",
      PAPERCLIP_AGENT_ROLE: "operator",
    });
    expect(attrs).toMatchObject({
      "service.namespace": "paperclip-staging",
      "service.name": "paperclip-canary",
      "deployment.environment": "macbook",
      "agent.surface": "cli",
      "agent.role": "operator",
    });
  });

  it("keeps fixed-identity attributes non-overridable", () => {
    const attrs = buildResourceAttributes({
      // These are not wired to env vars on purpose — Paperclip's identity is fixed.
      "agent.product": "spoofed",
    } as NodeJS.ProcessEnv);
    expect(attrs["agent.product"]).toBe("paperclip");
    expect(attrs["telemetry.source"]).toBe("native_otlp");
    expect(attrs["observability.domain"]).toBe("agent");
  });
});

describe("serializeResourceAttributes", () => {
  it("renders the OTEL_RESOURCE_ATTRIBUTES key=value form", () => {
    const serialized = serializeResourceAttributes({
      "a.one": "1",
      "b.two": "2",
    });
    expect(serialized).toBe("a.one=1,b.two=2");
  });
});

describe("applyResourceAttributes", () => {
  it("seeds OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME from the schema", () => {
    const env: NodeJS.ProcessEnv = {};
    applyResourceAttributes(env);
    expect(env.OTEL_SERVICE_NAME).toBe("paperclip-server");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain("observability.domain=agent");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain("telemetry.source=native_otlp");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain("agent.product=paperclip");
  });

  it("appends operator-supplied attributes last so they win on collision", () => {
    const env: NodeJS.ProcessEnv = {
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=bermont-kube,custom.tag=x",
    };
    applyResourceAttributes(env);
    const value = env.OTEL_RESOURCE_ATTRIBUTES ?? "";
    // schema defaults come first, operator override appended after
    expect(value.indexOf("deployment.environment=lue-kube")).toBeLessThan(
      value.indexOf("deployment.environment=bermont-kube"),
    );
    expect(value).toContain("custom.tag=x");
  });
});
