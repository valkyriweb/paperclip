type EnvMap = NodeJS.ProcessEnv | Record<string, string | undefined>;

function readEnv(env: EnvMap, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function inferOpenAiCompatibleBiller(
  env: EnvMap,
  fallback: string | null = "openai",
): string | null {
  const explicitOpenRouterKey = readEnv(env, "OPENROUTER_API_KEY");
  if (explicitOpenRouterKey) return "openrouter";

  const baseUrl =
    readEnv(env, "OPENAI_BASE_URL") ??
    readEnv(env, "OPENAI_API_BASE") ??
    readEnv(env, "OPENAI_API_BASE_URL");
  if (baseUrl && /openrouter\.ai/i.test(baseUrl)) return "openrouter";

  return fallback;
}

/**
 * Billing-type union, kept in lockstep with `BILLING_TYPES` in
 * `@paperclipai/shared/constants.ts`. Declared locally so adapter-utils stays
 * dependency-free and downstream adapter packages don't pick up @shared.
 */
export type BillingType =
  | "metered_api"
  | "subscription_included"
  | "subscription_overage"
  | "credits"
  | "fixed"
  | "unknown";

/**
 * Providers whose only auth path is a personal/team subscription, so any
 * request they handle is by definition `subscription_included` unless an env
 * override says otherwise.
 */
const SUBSCRIPTION_ONLY_PROVIDERS: ReadonlySet<string> = new Set([
  "github-copilot",
]);

/**
 * Providers that are always metered API services. Catches the common case
 * where no env signal is needed; the request hit a paid API endpoint with no
 * subscription wrapper.
 */
const METERED_API_PROVIDERS: ReadonlySet<string> = new Set([
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
]);

/**
 * Classify which billing surface will be charged for a request to `provider`.
 *
 * Defaults to `metered_api` for known metered services, `subscription_included`
 * for known subscription-only services, and resolves the two hybrid cases
 * (`claude-bridge`, `openai-codex`) by inspecting the runtime env.
 *
 * Falls back to `unknown` only for providers we have not tagged — callers
 * should add the provider to one of the two sets above rather than relying on
 * `unknown` rows in the cost dashboard.
 *
 * Hybrid resolution rules:
 *
 * - `claude-bridge` (Luke's local proxy at `~/Projects/personal/pi-claude-bridge`)
 *   selects auth mode from env at startup (see `index.js:312-336`):
 *   - `ANTHROPIC_API_KEY` set → apikey passthrough → `metered_api`
 *   - `_BRIDGE_OAUTH_TOKEN` set or macOS keychain present → OAuth →
 *     `subscription_included` (Claude Pro/Max plan)
 *   The classifier mirrors the env check so we don't need to invent a new
 *   side-channel between the bridge and the adapter.
 *
 * - `openai-codex` (Codex CLI) supports both ChatGPT login and an API key.
 *   `OPENAI_API_KEY` set → `metered_api`; otherwise we assume ChatGPT Plus/Pro
 *   login and emit `subscription_included`.
 */
export function classifyBillingType(
  provider: string | null | undefined,
  env: EnvMap = {},
): BillingType {
  if (!provider) return "unknown";

  if (provider === "claude-bridge") {
    return readEnv(env, "ANTHROPIC_API_KEY") ? "metered_api" : "subscription_included";
  }

  if (provider === "openai-codex") {
    return readEnv(env, "OPENAI_API_KEY") ? "metered_api" : "subscription_included";
  }

  if (SUBSCRIPTION_ONLY_PROVIDERS.has(provider)) return "subscription_included";
  if (METERED_API_PROVIDERS.has(provider)) return "metered_api";

  return "unknown";
}
