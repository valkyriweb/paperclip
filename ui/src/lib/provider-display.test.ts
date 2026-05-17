/**
 * providerDisplayName covers every biller string the Paperclip emitters can
 * produce, so the Costs dashboard's Billers tab and Finance cards render real
 * names instead of raw slugs like 'claude-bridge'.
 *
 * Substream: agent-system/PAPERCLIP-BUDGET-INTEGRATION.md G2 UI follow-up.
 */

import { describe, expect, it } from "vitest";
import { providerDisplayName } from "./utils";

describe("providerDisplayName", () => {
  it("renders direct-API providers", () => {
    expect(providerDisplayName("anthropic")).toBe("Anthropic");
    expect(providerDisplayName("openai")).toBe("OpenAI");
    expect(providerDisplayName("google")).toBe("Google");
    expect(providerDisplayName("google-vertex")).toBe("Google Vertex AI");
    expect(providerDisplayName("amazon-bedrock")).toBe("Amazon Bedrock");
    expect(providerDisplayName("azure-openai-responses")).toBe("Azure OpenAI");
    expect(providerDisplayName("deepseek")).toBe("DeepSeek");
    expect(providerDisplayName("groq")).toBe("Groq");
    expect(providerDisplayName("xai")).toBe("xAI");
    expect(providerDisplayName("openrouter")).toBe("OpenRouter");
    expect(providerDisplayName("vercel-ai-gateway")).toBe("Vercel AI Gateway");
    expect(providerDisplayName("mistral")).toBe("Mistral");
    expect(providerDisplayName("cohere")).toBe("Cohere");
    expect(providerDisplayName("perplexity")).toBe("Perplexity");
  });

  it("renders hybrid CLI billers (the ones introduced by this substream)", () => {
    expect(providerDisplayName("claude-bridge")).toBe("Claude Bridge");
    expect(providerDisplayName("claude-code")).toBe("Claude Code");
    expect(providerDisplayName("openai-codex")).toBe("Codex CLI");
  });

  it("renders subscription-only providers", () => {
    expect(providerDisplayName("github-copilot")).toBe("GitHub Copilot");
  });

  it("renders forwarder billers", () => {
    expect(providerDisplayName("multica")).toBe("Multica");
  });

  it("is case-insensitive", () => {
    expect(providerDisplayName("ANTHROPIC")).toBe("Anthropic");
    expect(providerDisplayName("Claude-Bridge")).toBe("Claude Bridge");
  });

  it("falls back to the raw slug for unknown billers (regression smell)", () => {
    // A raw-slug return is a hint that the biller needs to be added to the
    // map. The G2b verifier surfaces this gap via the Billers tab UI.
    expect(providerDisplayName("some-future-provider")).toBe("some-future-provider");
  });
});
