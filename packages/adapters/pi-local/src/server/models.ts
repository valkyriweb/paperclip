import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { asString, runChildProcess } from "@paperclipai/adapter-utils/server-utils";

const MODELS_CACHE_TTL_MS = 5 * 60_000;
const MODELS_CACHE_STALE_TTL_MS = 24 * 60 * 60_000;
const MODELS_CACHE_MAX_ENTRIES = 64;
const MODEL_DISCOVERY_TIMEOUT_SEC = 60;
const MODELS_DISCOVERY_TIMEOUT_COOLDOWN_MS = 5 * 60_000;

/**
 * Raised when `pi --list-models` could not be run to completion (timeout, spawn
 * failure, non-zero exit). It means model availability is *unknown*, which is
 * different from a completed discovery that did not list the configured model.
 */
export class PiModelDiscoveryUnavailableError extends Error {
  readonly timedOut: boolean;

  constructor(message: string, options?: { timedOut?: boolean }) {
    super(message);
    this.name = "PiModelDiscoveryUnavailableError";
    this.timedOut = options?.timedOut ?? false;
  }
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  const lines = stdout.split(/\r?\n/);
  
  // Skip header line if present
  let startIndex = 0;
  if (lines.length > 0 && (lines[0].includes("provider") || lines[0].includes("model"))) {
    startIndex = 1;
  }
  
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Parse format: "provider   model   context  max-out  thinking  images"
    // Split by 2+ spaces to handle the columnar format
    const parts = line.split(/\s{2,}/);
    if (parts.length < 2) continue;
    
    const provider = parts[0].trim();
    const model = parts[1].trim();
    
    if (!provider || !model) continue;
    if (provider === "provider" && model === "model") continue; // Skip header
    
    const id = `${provider}/${model}`;
    parsed.push({ id, label: id });
  }
  
  return parsed;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function resolvePiCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_PI_COMMAND === "string" &&
    process.env.PAPERCLIP_PI_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_PI_COMMAND.trim()
      : "pi";
  return asString(input, envOverride);
}

type DiscoveryCacheEntry = {
  expiresAt: number;
  staleUntil: number;
  models: AdapterModel[];
};

const discoveryCache = new Map<string, DiscoveryCacheEntry>();
const discoveryRequests = new Map<string, Promise<AdapterModel[]>>();
// A discovery that timed out costs MODEL_DISCOVERY_TIMEOUT_SEC of run wall clock.
// Remember it briefly so back-to-back runs on a contended host fail fast instead
// of each paying the full timeout again.
const discoveryTimeoutUntil = new Map<string, number>();
const VOLATILE_ENV_KEY_EXACT = new Set([
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_ISSUE_WORK_MODE",
  "PAPERCLIP_WAKE_REASON",
  "PAPERCLIP_WAKE_COMMENT_ID",
  "PAPERCLIP_APPROVAL_ID",
  "PAPERCLIP_APPROVAL_STATUS",
  "PAPERCLIP_LINKED_ISSUE_IDS",
  "PAPERCLIP_WAKE_PAYLOAD_JSON",
  "PAPERCLIP_WORKSPACE_CWD",
  "PAPERCLIP_WORKSPACE_SOURCE",
  "PAPERCLIP_WORKSPACE_STRATEGY",
  "PAPERCLIP_WORKSPACE_ID",
  "PAPERCLIP_WORKSPACE_REPO_URL",
  "PAPERCLIP_WORKSPACE_REPO_REF",
  "PAPERCLIP_WORKSPACE_BRANCH",
  "PAPERCLIP_WORKSPACE_WORKTREE_PATH",
  "PAPERCLIP_WORKSPACES_JSON",
]);

function isVolatileEnvKey(key: string): boolean {
  return VOLATILE_ENV_KEY_EXACT.has(key);
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryEnvironment(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isVolatileEnvKey(key)));
}

function discoveryCacheKey(command: string, cwd: string, env: Record<string, string>) {
  const envKey = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${cwd}\n${envKey}`;
}

function cacheDiscovery(key: string, entry: DiscoveryCacheEntry) {
  discoveryCache.delete(key);
  discoveryCache.set(key, entry);
  while (discoveryCache.size > MODELS_CACHE_MAX_ENTRIES) {
    const oldestKey = discoveryCache.keys().next().value;
    if (oldestKey === undefined) break;
    discoveryCache.delete(oldestKey);
  }
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.staleUntil <= now) discoveryCache.delete(key);
  }
}

async function runPiModelDiscovery(
  command: string,
  cwd: string,
  runtimeEnv: Record<string, string>,
): Promise<AdapterModel[]> {
  const result = await runChildProcess(
    `pi-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["--list-models"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: MODEL_DISCOVERY_TIMEOUT_SEC,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new PiModelDiscoveryUnavailableError("`pi --list-models` timed out.", {
      timedOut: true,
    });
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new PiModelDiscoveryUnavailableError(
      detail ? `\`pi --list-models\` failed: ${detail}` : "`pi --list-models` failed.",
    );
  }

  // Current Pi writes model rows to stdout; older releases wrote them to stderr.
  const output = result.stdout || result.stderr;
  return sortModels(dedupeModels(parseModelsOutput(output)));
}

export async function discoverPiModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolvePiCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const runtimeEnv = normalizeEnv({ ...process.env, ...env });
  return runPiModelDiscovery(command, cwd, runtimeEnv);
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export async function discoverPiModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolvePiCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const discoveryEnv = discoveryEnvironment(env);
  const runtimeEnv = normalizeEnv({ ...process.env, ...discoveryEnv });
  const key = discoveryCacheKey(command, cwd, runtimeEnv);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const cooldownUntil = discoveryTimeoutUntil.get(key);
  if (cooldownUntil !== undefined) {
    if (cooldownUntil > now) {
      if (cached && cached.staleUntil > now) return cached.models;
      throw new PiModelDiscoveryUnavailableError(
        "`pi --list-models` timed out recently; skipping discovery.",
        { timedOut: true },
      );
    }
    discoveryTimeoutUntil.delete(key);
  }

  let request = discoveryRequests.get(key);
  if (!request) {
    request = runPiModelDiscovery(command, cwd, runtimeEnv)
      .then((models) => {
        const refreshedAt = Date.now();
        discoveryTimeoutUntil.delete(key);
        cacheDiscovery(key, {
          expiresAt: refreshedAt + MODELS_CACHE_TTL_MS,
          staleUntil: refreshedAt + MODELS_CACHE_STALE_TTL_MS,
          models,
        });
        return models;
      })
      .catch((error: unknown) => {
        if (error instanceof PiModelDiscoveryUnavailableError && error.timedOut) {
          discoveryTimeoutUntil.set(key, Date.now() + MODELS_DISCOVERY_TIMEOUT_COOLDOWN_MS);
        }
        const stale = discoveryCache.get(key);
        if (!stale || stale.staleUntil <= Date.now()) throw error;
        console.warn("[paperclip] Pi model refresh failed; using cached models.");
        return stale.models;
      })
      .finally(() => {
        discoveryRequests.delete(key);
      });
    discoveryRequests.set(key, request);
  }

  return request;
}

/**
 * Fast path for the model preflight: Pi resolves custom providers/models from
 * `$PI_CODING_AGENT_DIR/models.json` (falling back to `$HOME/.pi/agent`), and
 * paperclip deployments declare their providers there. When the configured
 * model is listed in that file we can answer the preflight without spawning
 * `pi --list-models` at all — a full Pi CLI boot that costs ~15s on a cold
 * volume and is the top agent-error source when it overruns its 60s cap.
 * Returns null when the file is absent/unreadable/unparseable or does not
 * mention the model (e.g. built-in providers), so callers fall back to spawn
 * discovery.
 */
export async function readPiModelsFromAgentConfig(
  runtimeEnv: Record<string, string>,
): Promise<AdapterModel[] | null> {
  const agentDir =
    runtimeEnv.PI_CODING_AGENT_DIR?.trim() ||
    path.join(runtimeEnv.HOME?.trim() || os.homedir(), ".pi", "agent");
  let raw: string;
  try {
    raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { providers?: Record<string, { models?: unknown }> };
    if (!parsed || typeof parsed !== "object" || !parsed.providers) return null;
    const models: AdapterModel[] = [];
    for (const [provider, config] of Object.entries(parsed.providers)) {
      if (!config || typeof config !== "object" || !Array.isArray(config.models)) continue;
      for (const entry of config.models) {
        const id =
          typeof entry === "string"
            ? entry
            : typeof (entry as { id?: unknown })?.id === "string"
              ? (entry as { id: string }).id
              : "";
        if (!id.trim()) continue;
        const full = `${provider}/${id.trim()}`;
        models.push({ id: full, label: full });
      }
    }
    if (models.length === 0) return null;
    return sortModels(dedupeModels(models));
  } catch {
    return null;
  }
}

export async function ensurePiModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = asString(input.model, "").trim();
  if (!model) {
    throw new Error("Pi requires `adapterConfig.model` in provider/model format.");
  }

  // Answer from the static Pi agent config when it already lists the model;
  // no child process needed.
  const fileEnv = normalizeEnv({ ...process.env, ...normalizeEnv(input.env) });
  const fileModels = await readPiModelsFromAgentConfig(fileEnv);
  if (fileModels?.some((entry) => entry.id === model)) return fileModels;

  let models: AdapterModel[];
  try {
    models = await discoverPiModelsCached({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
    });
  } catch (error) {
    if (!(error instanceof PiModelDiscoveryUnavailableError) || !error.timedOut) throw error;
    // Model discovery is a preflight check, not the run itself. When the check
    // cannot be completed (the child process timed out) we do
    // not know that the model is bad, so failing the run here turns a slow node
    // into a failed agent run. Warn and let the run proceed; a genuinely bad
    // model still fails with the adapter's own error.
    console.warn(
      `[paperclip] Pi model discovery unavailable (${error.message}); skipping model preflight for ${model}.`,
    );
    return [];
  }

  if (models.length === 0) {
    throw new Error("Pi returned no models. Run `pi --list-models` and verify provider auth.");
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured Pi model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

export async function listPiModels(): Promise<AdapterModel[]> {
  try {
    return await discoverPiModelsCached();
  } catch {
    return [];
  }
}

export function resetPiModelsCacheForTests() {
  discoveryCache.clear();
  discoveryRequests.clear();
  discoveryTimeoutUntil.clear();
}

export function piModelsCacheSizeForTests() {
  return discoveryCache.size;
}
