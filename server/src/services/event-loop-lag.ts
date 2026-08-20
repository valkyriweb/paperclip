import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { logger } from "../middleware/logger.js";

export interface EventLoopLagSnapshot {
  /** Max observed event-loop delay in ms over the last sample window. */
  maxMs: number;
  /** p99 event-loop delay in ms over the last sample window. */
  p99Ms: number;
  /** Mean event-loop delay in ms over the last sample window. */
  meanMs: number;
  /** When the last sample window closed (ISO), null before the first window. */
  sampledAt: string | null;
  /** Worst max seen since the monitor started, in ms. */
  worstMaxMs: number;
  /** When the worst max was observed (ISO), null before the first window. */
  worstMaxAt: string | null;
}

const SAMPLE_INTERVAL_MS = 5_000;
const WARN_THRESHOLD_MS = 1_000;
const WARN_COOLDOWN_MS = 30_000;

let histogram: IntervalHistogram | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastWarnAt = 0;
let snapshot: EventLoopLagSnapshot = {
  maxMs: 0,
  p99Ms: 0,
  meanMs: 0,
  sampledAt: null,
  worstMaxMs: 0,
  worstMaxAt: null,
};

const toMs = (nanos: number) => Math.round((nanos / 1e6) * 100) / 100;

/**
 * Cheap event-loop lag watchdog. A wedged event loop starves every request —
 * including health probes — so the instance 503s with the database idle and
 * nothing in the logs explaining why. Sampling perf_hooks'
 * monitorEventLoopDelay histogram every few seconds costs near-nothing and
 * leaves a durable warn trail (plus a snapshot on /api/health) when the loop
 * stalls for more than a second.
 */
export function startEventLoopLagMonitor(): void {
  if (timer) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  timer = setInterval(() => {
    if (!histogram) return;
    const now = new Date();
    const maxMs = toMs(histogram.max);
    snapshot = {
      maxMs,
      p99Ms: toMs(histogram.percentile(99)),
      meanMs: toMs(histogram.mean),
      sampledAt: now.toISOString(),
      worstMaxMs: Math.max(snapshot.worstMaxMs, maxMs),
      worstMaxAt: maxMs >= snapshot.worstMaxMs ? now.toISOString() : snapshot.worstMaxAt,
    };
    histogram.reset();
    if (maxMs >= WARN_THRESHOLD_MS && Date.now() - lastWarnAt >= WARN_COOLDOWN_MS) {
      lastWarnAt = Date.now();
      logger.warn(
        { eventLoopLag: snapshot },
        "event loop lag exceeded 1s in the last sample window; requests (including health probes) were stalled",
      );
    }
  }, SAMPLE_INTERVAL_MS);
  timer.unref?.();
}

export function stopEventLoopLagMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
  histogram?.disable();
  histogram = null;
}

export function getEventLoopLagSnapshot(): EventLoopLagSnapshot {
  return snapshot;
}
