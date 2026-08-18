# Paperclip timeout diagnosis — application-side second opinion

Date: 2026-08-18
Lane: `paperclip-timeout-rev` (branch `lue/paperclip-timeout-rev`)
Scope: application side only. No cluster writes were made; no `lue-kube` changes.

## Verdict in one line

Every recorded timeout in this system is the **`openclaw_gateway` adapter** hitting **its own
wall-clock limits in `packages/adapters/openclaw-gateway/src/server/execute.ts`**. It is not a
database, connection-pool, CPU, or node-capacity problem. The run-duration class has already been
fixed by raising a config value; a smaller, still-latent transport class remains and **cannot** be
fixed the same way because its limit is hard-capped in code.

## The named failure path

```
openclaw-gateway execute.ts:1351   -> errorMessage: `OpenClaw gateway run timed out after ${waitTimeoutMs}ms`
                                      sets adapterResult.timedOut = true
server/src/services/heartbeat.ts:11899 -> } else if (adapterResult.timedOut) { outcome = "timed_out"; }
                                      -> heartbeat_runs.status = 'timed_out'
```

The boundary is a **websocket wait on an in-cluster OpenClaw gateway**
(`ws://openclaw.openclaw.svc.cluster.local:18789`), not a DB call, not an HTTP client, not pool
acquisition.

## Evidence

### 1. The symptom is 100% one adapter

`heartbeat_runs` joined to `agents`, all time:

| adapter | runs | timed_out | rate | last run |
|---|---|---|---|---|
| `pi_local` | 12,092 | **0** | 0.00% | 2026-08-18 |
| `openclaw_gateway` | 1,958 | **277** | **14.15%** | 2026-08-18 |
| `claude_local` | 417 | **0** | 0.00% | 2026-08-18 |
| `codex_local` | 92 | **0** | 0.00% | 2026-08-17 |

This single table refutes every resource-based theory. `pi_local` does **6x the run volume** on the
same pod, same node, same Postgres, same connection pool, and times out **zero** times. A shared
resource constraint cannot select one adapter and spare another at 6x the load.

### 2. The error strings name their own limits

```
OpenClaw gateway run timed out after 300000ms | 202 | 2026-05-06 -> 2026-07-05
OpenClaw gateway run timed out after 900000ms |  27 | 2026-06-01 -> 2026-07-11
gateway request timeout (agent)               |  25 | 2026-05-22 -> 2026-08-02
gateway websocket open timeout                |  17 | 2026-05-06 -> 2026-07-27
gateway request timeout (connect)             |   3 | 2026-04-28 -> 2026-07-04
OpenClaw gateway run timed out after 600000ms |   1 | 2026-06-01
gateway request timeout (agent.wait)          |   1 | 2026-07-05
OpenClaw gateway run timed out after 120000ms |   1 | 2026-04-24
```

### 3. Run durations prove the limit is the cause, not a symptom

`openclaw_gateway` run durations in seconds:

| status | n | p50 | p95 | max |
|---|---|---|---|---|
| succeeded | 960 | 143 | **527** | 1048 |
| timed_out | 277 | **302** | **910** | 1770 |
| failed | 552 | 8 | 453 | 1083 |
| cancelled | 169 | 166 | 306 | 620 |

The `timed_out` p50 of **302s** is the 300,000 ms limit, and p95 of **910s** is the 900,000 ms limit.
The duration distribution of timed-out runs *is* the set of configured limits — these rows are the
timer firing, nothing else.

Critically, **successful** runs reach p95 527s and max 1048s. The workload's natural duration
overlaps the budget heavily: at a 300s limit, a normal p95 run was already 1.75x over.

## Two distinct causes, ranked

### Cause 1 — run-duration limit set below the workload (202+27+1+1 = 231 of 277, 83%). RESOLVED.

`execute.ts:1064`:

```ts
const waitTimeoutMs = parseOptionalPositiveInteger(ctx.config.waitTimeoutMs)
  ?? (timeoutMs > 0 ? timeoutMs : 30_000);
```

with the adapter default `timeoutSec` = 120 (`execute.ts:1061`).

The limit was raised over time — and the error strings record the staircase:

| limit | first seen | last seen |
|---|---|---|
| 120,000 ms (code default) | 2026-04-24 | 2026-04-24 |
| 300,000 ms | 2026-05-06 | 2026-07-05 |
| 600,000 ms | 2026-06-01 | 2026-06-01 |
| 900,000 ms | 2026-06-01 | **2026-07-11** |

All five live `openclaw_gateway` agents now carry `timeoutSec=900` / `waitTimeoutMs=900000`.
**No run-duration timeout has occurred since 2026-07-11.**

Fix: already applied (config raised to 900s). No further action. Monitor: successful p95 is 527s, so
900s leaves ~1.7x headroom. If run lengths grow, this returns.

### Cause 2 — connect/transport limit hard-capped at 15s in code (46 of 277, 17%). STILL LATENT.

`execute.ts:1063`:

```ts
const connectTimeoutMs = timeoutMs > 0 ? Math.min(timeoutMs, 15_000) : 10_000;
```

This value is used for the websocket open (`execute.ts:694`), the connect challenge, and — notably —
the `agent` run-submission request (`execute.ts:1290-1292`).

**`Math.min(timeoutMs, 15_000)` means raising `timeoutSec` cannot raise this.** An operator who
fixes Cause 1 by raising the limit to 900s still has a 15s ceiling on connect and submission. This is
the trap: the obvious fix does not touch this class.

These failures arrive in **tight bursts**, which is an availability signature, not a load one:

```
2026-07-27 05:53:33  gateway websocket open timeout
2026-07-27 05:53:37  gateway websocket open timeout
2026-07-27 05:53:37  gateway websocket open timeout
2026-07-27 05:53:50  gateway websocket open timeout
2026-07-27 05:54:11  gateway websocket open timeout
2026-07-27 05:54:24  gateway websocket open timeout
2026-07-27 05:55:08  gateway websocket open timeout
```

Seven failures in 95 seconds = the gateway endpoint was gone. `openclaw-0` is a StatefulSet pod in
the `openclaw` namespace on a **different node** (`lue-and-naddy-kube`) from paperclip
(`lue-and-naddy-mbp-old`); it recycles periodically (currently 7h31m old, 0 restarts). A restart or
rollout of `openclaw-0` removes the websocket endpoint and produces exactly this burst.

Fix (application side, this repo):
1. Make the connect timeout configurable instead of hard-capped — replace
   `Math.min(timeoutMs, 15_000)` with a `connectTimeoutMs` config key defaulting to 15s.
2. Add bounded retry with backoff around websocket open and the `agent` submission. A gateway pod
   restart is an expected event and should cost a retry, not a failed run. Today a single 15s blip
   burns the whole run.
3. Classify these distinctly. Recording a 15s connect failure and a 900s run overrun both as
   `timed_out` is what made this look like one problem for four months.

## Hypotheses explicitly refuted

- **Connection-pool saturation** (the brief asked for a number). Refuted. The app client is
  `postgres(url)` in `packages/db/src/client.ts:49` — postgres.js default `max: 10`. Live
  `pg_stat_activity`: **8 total connections, 2 active, 0 idle, 0 waiting on a lock**, against
  `max_connections=100`. The pool is not saturated, and the timeout does not fire on a DB call
  anyway. (`max: 1` at `client.ts:14` is `createUtilitySql`, migrations only — not the app path.)
- **Postgres resource starvation** — already ruled out by the Captain; my data agrees and adds that
  no timeout error string references the database at all.
- **CPU throttling** — already ruled out (~4%); agreed, and independently: throttling would not
  spare `pi_local` at 12,092 runs.
- **Node capacity / node pressure** (sibling lane's angle) — cannot be the cause of the 277 rows,
  for the same `pi_local` reason. It is, however, a plausible trigger for the *Cause 2* bursts.

## Could not test

- Correlation of the 2026-07-27 and 2026-07-04 bursts against cluster events: Kubernetes events for
  those dates have long since aged out. The burst shape is strong circumstantial evidence but the
  triggering event is unrecoverable.
- Historical pool state. Only current `pg_stat_activity` is observable; there is no stored history.
- Which specific change raised the limits and when. The values live in agent DB config, not in git,
  and `agents` carries no config-change audit trail.

## Reported, not acted on (sibling lane's territory)

Observed live during this investigation, all in the infrastructure lane's scope:

- `paperclip-6f5f957759-vp585` was `1/2 Running` with **both** containers `ready=false`:
  `paperclip` readiness `GET /api/health` -> `context deadline exceeded`; `pinchtab` readiness
  `curl 127.0.0.1:9867/instances` -> `timed out after 5s`.
- A `NodeNotReady` event on `lue-and-naddy-mbp-old` during the session; the node returned to `Ready`.
- `paperclip-pg-2` (the **primary**) restart count went **6 -> 7 while this lane was running**
  (`exitCode 0`, `reason: Completed`, uptime 11:53:07 -> 14:21:24, i.e. ~2h28m). Clean restarts, as
  the Captain measured — but the *cadence* is unexplained and worth a look.
- The kube API server itself was intermittently unreachable (`TLS handshake timeout`,
  `http2: client connection lost`) during queries.

These are real and current, but they are **not** the cause of `heartbeat_runs.status='timed_out'`.

## Also worth noting

- The application log is dominated by a tight loop of
  `heartbeat timer tick failed / Agent cannot start because its budget hard-stop is still exceeded`
  (409, `heartbeat.ts:13470`), firing every ~30s for agent `bb18774d-55ff-48e7-8b56-2eeff92a5c46`.
  Harmless but it buries real signal in the logs.
- 144 `openclaw_gateway` rows have a NULL `started_at` (queued, never started) and are excluded from
  the rate table above.
