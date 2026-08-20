import type { agents } from "@paperclipai/db";
import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@paperclipai/shared";
import { parseObject, asBoolean, asNumber } from "../adapters/utils.js";

const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MIN = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 50;

export function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

function normalizeOptionalNonNegativeInteger(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Math.floor(asNumber(value, 0));
  return normalized >= 0 ? normalized : null;
}

/**
 * Parse an agent's heartbeat runtime policy. Extracted from heartbeatService so
 * recovery backstops can honour the same wake gates (e.g. wakeOnDemand) without
 * enqueueing wake requests that the heartbeat service would immediately skip.
 */
export function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const heartbeat = parseObject(runtimeConfig.heartbeat);

  return {
    enabled: asBoolean(heartbeat.enabled, false),
    intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
    wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
    maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
    skipTimerWhenNoActionableWork: asBoolean(
      heartbeat.skipTimerWhenNoActionableWork ??
        heartbeat.requireActionableTimerWork ??
        heartbeat.issueOnlyTimer,
      false,
    ),
    maxDailyRuns: normalizeOptionalNonNegativeInteger(
      heartbeat.maxDailyRuns ?? heartbeat.dailyRunLimit ?? heartbeat.dailyRunCap ?? heartbeat.maxRunsPerDay,
    ),
    maxDailyCostCents: normalizeOptionalNonNegativeInteger(
      heartbeat.maxDailyCostCents ??
        heartbeat.dailyCostCentsLimit ??
        heartbeat.dailySpendCentsLimit ??
        heartbeat.dailyBudgetCents,
    ),
  };
}
