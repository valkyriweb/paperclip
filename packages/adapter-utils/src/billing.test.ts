import { describe, expect, it } from "vitest";
import { classifyBillingType, inferOpenAiCompatibleBiller } from "./billing.js";

describe("inferOpenAiCompatibleBiller", () => {
  it("returns openrouter when OPENROUTER_API_KEY is present", () => {
    expect(
      inferOpenAiCompatibleBiller({ OPENROUTER_API_KEY: "sk-or-123" } as NodeJS.ProcessEnv, "openai"),
    ).toBe("openrouter");
  });

  it("returns openrouter when OPENAI_BASE_URL points at OpenRouter", () => {
    expect(
      inferOpenAiCompatibleBiller(
        { OPENAI_BASE_URL: "https://openrouter.ai/api/v1" } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openrouter");
  });

  it("returns fallback when no OpenRouter markers are present", () => {
    expect(
      inferOpenAiCompatibleBiller(
        { OPENAI_BASE_URL: "https://api.openai.com/v1" } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openai");
  });
});

describe("classifyBillingType", () => {
  it("returns unknown when provider is missing", () => {
    expect(classifyBillingType(null)).toBe("unknown");
    expect(classifyBillingType(undefined)).toBe("unknown");
    expect(classifyBillingType("")).toBe("unknown");
  });

  it("claude-bridge with ANTHROPIC_API_KEY is metered", () => {
    expect(classifyBillingType("claude-bridge", { ANTHROPIC_API_KEY: "sk-ant-…" })).toBe("metered_api");
  });

  it("claude-bridge without ANTHROPIC_API_KEY is subscription", () => {
    expect(classifyBillingType("claude-bridge", {})).toBe("subscription_included");
    expect(classifyBillingType("claude-bridge", { _BRIDGE_OAUTH_TOKEN: "…" })).toBe("subscription_included");
  });

  it("openai-codex with OPENAI_API_KEY is metered", () => {
    expect(classifyBillingType("openai-codex", { OPENAI_API_KEY: "sk-…" })).toBe("metered_api");
  });

  it("openai-codex without OPENAI_API_KEY is subscription (ChatGPT login)", () => {
    expect(classifyBillingType("openai-codex", {})).toBe("subscription_included");
  });

  it("github-copilot is always subscription", () => {
    expect(classifyBillingType("github-copilot", {})).toBe("subscription_included");
    expect(classifyBillingType("github-copilot", { ANTHROPIC_API_KEY: "x" })).toBe("subscription_included");
  });

  it.each([
    "openai",
    "anthropic",
    "google",
    "google-vertex",
    "amazon-bedrock",
    "azure-openai-responses",
    "deepseek",
    "groq",
    "xai",
    "openrouter",
    "vercel-ai-gateway",
    "mistral",
    "cohere",
    "perplexity",
  ])("%s is metered", (provider) => {
    expect(classifyBillingType(provider, {})).toBe("metered_api");
  });

  it("unknown providers fall back to unknown", () => {
    expect(classifyBillingType("some-new-provider", {})).toBe("unknown");
  });

  it("empty-string env values do not flip the bridge to metered", () => {
    // matches the readEnv semantics: empty/whitespace counts as absent
    expect(classifyBillingType("claude-bridge", { ANTHROPIC_API_KEY: "" })).toBe("subscription_included");
    expect(classifyBillingType("claude-bridge", { ANTHROPIC_API_KEY: "   " })).toBe("subscription_included");
  });
});
