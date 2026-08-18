# Paperclip performance triage — verdict

Date: 2026-08-18
Lane: `paperclip-perf-triage`
Cluster: `lue-kube`, namespace `paperclip`, node `lue-and-naddy-mbp-old`

## One-line answer

**Paperclip is not resource-constrained. Its node is I/O- and memory-saturated, that
saturation makes co-located etcd miss its fsync budget, the resulting Kubernetes API
stalls trip CloudNativePG's 1-second liveness isolation check, and each trip costs a
~181-second Postgres primary outage.** The timeouts are a control-plane availability
problem wearing a database costume.

Every ranked cause below has a measurement. Where a number is weak or was polluted by
my own probing, I say so.

---

## Ranked causes

### 1. Node `lue-and-naddy-mbp-old` is I/O-saturated — evidence: strong

Measured directly on the node, with no diagnostic load of mine running:

```
16:41:55 up 33 days, load average: 23.93, 55.22, 59.99      # 8 cores
%Cpu(s): 19.8 us, 24.4 sy, 0.0 ni, 2.1 id, 49.6 wa, 0.0 hi, 4.1 si, 0.0 st
MiB Mem : 15888.8 total, 197.1 free, 13135.0 used, 2995.9 buff/cache
MiB Swap:  4096.0 total, 2987.2 free, 1108.8 used
```

- **49.6% iowait against 19.8% user CPU.** The node is not short of CPU. It is waiting
  on disk for half of every second.
- **Load average 24 (1m) / 60 (15m) on 8 cores** — 3–7× oversubscribed, and the run queue
  is full of D-state (uninterruptible, I/O-blocked) tasks, not runnable ones.
- **197 MB free of 15.9 GB, with 1.1 GB swapped out.** `kswapd0` was observed burning
  20% of a core continuously.
- 16 processes in D-state at sample time, including `postgres`, `node` (Paperclip),
  `longhorn-manager`, `frigate.process`, `frigate.output` and two `ffmpeg`. One `node`
  process was blocked in **`ioc_rqos_throttle`** — direct kernel evidence of blk-iocost
  I/O throttling.

Corroborating cgroup evidence from inside the Paperclip pod (taken earlier, independent
of node access):

| container | pgscan / pgsteal | file refaults | major faults |
|---|---|---|---|
| `paperclip` | 106,304 / 106,104 | 38,801 | 277 |
| `pinchtab`  | 118,155 / 113,409 | 41,069 | **5,105** |

`pgsteal_kswapd` ≈ 100% of `pgsteal` in both — the kernel is continuously evicting these
containers' page cache. `memory.events` shows `oom_kill 0`, so nothing is being killed;
it is being *slowed*.

**Honesty note:** an earlier sample showed load 98 and 67% iowait with `dm-0` at 100%
utilisation and queue depth 82. A large part of that spike was **my own `journalctl`
reading at 253 MB/s**. The clean re-measurement above (load 24–60, 49.6% iowait) is the
one to trust. The first `iostat` sample of the session, taken before any journal reads,
showed `dm-0` at only 13% util — so disk load is bursty, not pinned.

### 2. Co-located etcd misses its fsync budget — evidence: strong

etcd is fsync-bound; it lives on the saturated disk above. From etcd's own metrics on
`lue-and-naddy-mbp-old` (port 2381):

```
etcd_disk_wal_fsync_duration_seconds_sum    4742.28 / count 946846  → mean 5.01 ms
etcd_disk_backend_commit_duration_seconds_sum 3148.72 / count 486651 → mean 6.47 ms
etcd_server_slow_apply_total                11893  → 13307 during this session
etcd_server_leader_changes_seen_total       7      → 9     during this session
etcd_server_is_leader                       0      (this node is a follower)
etcd_mvcc_db_total_size_in_bytes            114.5 MB (small — not a compaction problem)
```

WAL fsync bucket distribution (n=947,117):

| ≤ | count | cumulative |
|---|---|---|
| 8 ms | 871,217 | 92.0% |
| 16 ms | 934,420 | 98.7% |
| 32 ms | 940,173 | **99.27%** |
| 256 ms | 945,532 | 99.83% |
| 1.024 s | 947,097 | — |
| 2.048 s | 947,116 | — |

**p99 WAL fsync ≈ 32 ms against etcd's documented < 10 ms health threshold — 3× over.**
The tail is worse than the percentile suggests: 278 fsyncs took > 256 ms, 20 took
> 512 ms, 19 took > 1 s, and one took > 2 s. A WAL fsync over one second stalls etcd's
entire write path.

Independent controlled confirmation, same storage class (`local-path`), same PostgreSQL
image, same 500 × 8 KiB `O_DSYNC` workload, different nodes:

| node | time | per-fsync |
|---|---|---|
| `lue-and-naddy-mbp-old` (control-plane + etcd) | 2.65 / 2.67 / 2.69 s | **5.3 ms** |
| `lue-and-naddy-kube` (worker) | 0.43 / 0.43 / 0.29 s | **0.66 ms** |

**8× slower, and rock-steady across runs — this is the device and its queue, not a blip.**
The dd figure (5.3 ms) and etcd's own mean WAL fsync (5.01 ms) agree to within 6%.

### 3. The etcd cluster also spans a ~25 ms WAN link — evidence: strong

Every etcd member sits on a Tailscale `100.x` address, but they are not co-located:

| peer | ICMP RTT from mbp-old |
|---|---|
| `lue-and-naddy-kube` (LAN) | **0.66 ms** |
| `lue-kube-cp-01` | **26.0 ms** |
| `lue-kube-cp-02` | **23.8 ms** |

etcd's own view is worse, because it includes TLS, gRPC and queueing:

```
etcd_network_peer_round_trip_time_seconds  →  58.0 ms and 63.3 ms mean
```

`lue-and-naddy-mbp-old` is a **follower**, so every linearizable read its API server
serves needs a `ReadIndex` quorum round-trip to a leader ~25–60 ms away, and every write
needs quorum commit across that link. etcd's defaults (`heartbeat-interval` 100 ms,
`election-timeout` 1000 ms) are marginal at this RTT. **9 leader changes** and **13,307
slow applies** are the direct consequence.

This is an architectural fault independent of load: a 3-member etcd quorum split between
a home LAN and two remote VMs cannot be made fast by resizing Paperclip.

### 4. The API server stalls, and that is what pods actually see — evidence: strong

From `journalctl -u k3s` on the node — **967 occurrences of "apply request took too long"
in a 25-minute window (~39/min)**, against etcd's `expected-duration: 100ms`:

```
"apply request took too long","took":"6.595818209s","prefix":"read-only range ",
  "request":"key:\"/registry/events/hermes/hermes-0...\""
"apply request took too long","took":"4.493377991s",
  "request":"key:\"/registry/secrets/paperclip/paperclip-postgres\""
"apply request took too long","took":"2.424902673s",
  "request":"key:\"/registry/configmaps/paperclip/cnpg-default-monitoring\""
"apply request took too long","took":"499.841108ms",
  "request":"key:\"/registry/postgresql.cnpg.io/clusters/paperclip/paperclip-pg\""
"waiting for ReadIndex response took too long, retrying" (repeating, 500 ms retry)
E leaderelection.go:436] error retrieving resource lock kube-system/kube-scheduler:
  context deadline exceeded
```

Paperclip's *own* keys are among the slow reads. When even `kube-scheduler` and
`kube-controller-manager` cannot renew their leases, this is a whole-control-plane stall.

Observed live, three times during this session:
- **14:19** — both `paperclip-pg-1` and `paperclip-pg-2` degraded to `1/2` simultaneously,
  along with the CNPG operator (`ContainerStatusUnknown`, 10 restarts),
  `horizon-billing-pg-1`, `multica-pg-2`, `longhorn-manager`, and 13 pods total on this
  node. All four kubelet node conditions transitioned at `2026-08-18T14:19:18Z` — the node
  had gone `NotReady` and come back, while the k3s process itself had been up 22 h
  (`NRestarts=17` historically, but `ExecMainStartTimestamp` = previous day).
- **14:32 and 14:43** — `kubectl` itself failed: `dial tcp 100.76.128.14:6443: i/o timeout`,
  and SSH to the node timed out.

### 5. CNPG's 1-second isolation check converts an API stall into a failover — evidence: strong

Live cluster spec (`paperclip-pg`):

```yaml
probes:
  liveness:
    isolationCheck:
      enabled: true
      connectionTimeout: 1000    # ms
      requestTimeout: 1000       # ms
smartShutdownTimeout: 180
```

A **1000 ms** budget on a control plane that routinely stalls for 2.4–6.6 s cannot hold.
The captured failure, in order:

```
12:10:19Z  ERROR "Instance connectivity error - liveness probe failing"
           apiServerReachable: false
           apiServerErr: Get https://10.43.0.1:443/... context deadline exceeded
           error: ... Get "https://10.42.2.194:8000/failsafe": context deadline exceeded
12:11:27Z  "Received termination signal" signal=terminated smartShutdownTimeout=180
12:11:28Z  "received smart shutdown request"
12:14:29Z  "Error while handling the smart shutdown request" err=exit status 1
           "Requesting fast shutdown of the PostgreSQL instance"
12:14:32Z  "server stopped" / "PostgreSQL instance shut down"   → exit 0
12:14:30Z  operator: "Current primary isn't healthy, initiating a failover"
```

Both halves of the isolation check failed at once — the API server *and* pod-to-pod reach
to the peer — which is the signature of a node/control-plane stall, not of a sick database.

### 6. Smart shutdown blocks the full 180 s because the app never closes its pool — evidence: strong

`12:11:28.15 → 12:14:29.03` = **180.9 seconds**, exactly the configured `smartShutdownTimeout`,
then escalation to fast shutdown. PostgreSQL's *smart* shutdown waits for every client
session to disconnect voluntarily. Paperclip holds idle pooled connections that never close:

```
 application_name | client_addr | state | count
------------------+-------------+-------+-------
 postgres.js      | 10.42.4.231 | idle  |     9
```

(`packages/db/src/client.ts` → `createDb()` calls `postgres(url)` with no `max`, i.e.
postgres.js's default pool of 10. Note the `max: 1` in the same file belongs to
`createUtilitySql()`, the migration helper — not the app path.)

**This is the single biggest multiplier in the chain.** It turns a failover that should
take ~2 seconds into a ~3-minute primary outage. It is also the cheapest thing to fix.

### 7. CPU throttling — real, small, and *not* the cause — evidence: strong (negative)

Confirming the Captain's correction independently, from `cpu.stat` in-pod:

| container | window | periods | throttled | % | throttled time |
|---|---|---|---|---|---|
| `paperclip` | lifetime (41 min) | 24,495 | 853 | **3.5%** | 100.7 s |
| `paperclip` | live 77 s delta | 768 | 19 | **2.5%** | 1.83 s |
| `pinchtab` | lifetime | 21,305 | 302 | **1.4%** | 66.5 s |

`cpu.max` is `300000 100000` = 3 cores. **CFS throttling is enforced at the limit, not the
request**, and node CPU utilisation is only 19.8% user — so the "burstable pod pulled back
toward its request under contention" mechanism is *not* operating here. Throttling is a
~2–4% tax. **Ruled out.**

### 8. Postgres itself — healthy, ruled out — evidence: strong (negative)

| metric | value | verdict |
|---|---|---|
| cache hit ratio | **98.98%** | healthy |
| `blk_read_time` / `blk_write_time` | **0 / 0** | no I/O stall in-engine |
| ungranted locks | **0** | no lock contention |
| longest active query | **00:00:00** | nothing slow running |
| connections | **17 of `max_connections` 100** (9 idle app + rest) | not saturated |
| app pool | postgres.js default **max 10**, 9 idle / 0–2 active | **not exhausted** |
| checkpoints | 23 timed, 2 requested, `sync_time` 339 ms | spread, healthy |
| DB size | 8,088 MB | — |
| pg-2 volume fsync | **0.66 ms** | fast |

**Correction to the brief:** Postgres is on **`local-path`, not Longhorn**
(`paperclip-pg-1` / `paperclip-pg-2` PVCs). Only `paperclip-home-longhorn` and
`pinchtab-profiles-longhorn` are Longhorn. Measuring "Longhorn latency on the Postgres
volume" would have measured the wrong device.

**Blind spot, stated plainly:** `pg_stat_statements` **is not installed**
(`relation "pg_stat_statements" does not exist`; `shared_preload_libraries` is empty), so
per-statement latency could not be checked. Given 0 lock waits, 0 block I/O time, 98.98%
cache hit and no active queries, I do not believe slow SQL is a contributor — but that is
inference, not measurement, and it is the one objective I could not execute as written.

### 9. Longhorn adds a real but modest tax on the app volume — evidence: moderate

Same node, same 500 × 8 KiB `O_DSYNC` workload:

| path | per-fsync |
|---|---|
| `/paperclip` (Longhorn, replicated) | **7.1–8.9 ms** |
| `/tmp` (node local disk) | **5.2 ms** |

So Longhorn's replication costs ~1.4×, on top of a node baseline that is already 8× slower
than the healthy worker. Buffered throughput is fine (1.2 GB/s), so this is purely
synchronous-write latency. It matters for agent workspaces, git operations and run-log
writes on `/paperclip`, and it is a contributor to the node's I/O queue — but it is a
second-order effect, not the cause of the timeouts.

### 10. Timeouts as reported have already stopped — evidence: strong (negative)

Working back from the symptom, as instructed:

```
 status    | count            heartbeat_runs, all time
-----------+-------
 succeeded | 10521
 failed    |  2249
 cancelled |  1508
 timed_out |   277
```

But by month:

| month | timed_out | total | rate |
|---|---|---|---|
| 2026-05 | 136 | 3,428 | 4.0% |
| 2026-06 | 58 | 2,599 | 2.2% |
| 2026-07 | 80 | 5,835 | 1.4% |
| 2026-08 | **1** | 2,636 | **0.04%** |

**The last `timed_out` heartbeat run was 2026-08-02 — 16 days ago. Zero in the last 14
days across 1,605 runs.** The run-level timeout symptom that motivated this lane is
already resolved, most plausibly by the `paperclip-perf-inbox-fix` lane
(`fix(heartbeat): harden live-run progress and inbox refresh`,
`fix(heartbeat): durably record wakeup skips and assignment failures (#102)`).

What *is* still failing, right now, every 30 seconds:

```
[14:16:23] ERROR: heartbeat timer tick failed
[14:16:53] ERROR: heartbeat timer tick failed
```

98 occurrences in the pod's ~49-minute life.

> **Correction (added after the first version of this document).** The first draft said the
> error payload "renders empty" and was therefore undiagnosable. **That was wrong, twice.**
> The payload renders fine; I had only grepped the *stdout* stream, where `pino-pretty`
> prints the message line and the `err:` block on following lines that my single-line grep
> discarded. The app also writes a persistent `server.log` to the Longhorn volume that
> survives restarts, and it had the full stack all along. I also briefly suspected a missing
> pino `err` serializer; that was disproved by a repro against real `pino@9.14` +
> `pino-pretty@13.1` — pino 9 applies it by default and output was byte-identical with and
> without. Lesson recorded in friction: **read the file log before theorising about the
> logger.**

The actual error, from `/paperclip/instances/default/logs/server.log`:

```
[13:20:31] ERROR: heartbeat timer tick failed
    err: {
      "type": "HttpError",
      "message": "Agent cannot start because its budget hard-stop is still exceeded.",
      "stack":
          Error: Agent cannot start because its budget hard-stop is still exceeded.
              at conflict (/app/server/src/errors.ts:29:10)
              at enqueueWakeup (/app/server/src/services/heartbeat.ts:13470:13)
              at async Object.tickTimers (/app/server/src/services/heartbeat.ts:14922:21)
```

This is a **genuine application bug, unrelated to the cluster**, and it is the highest-value
finding in this lane. `enqueueWakeup` writes a `skipped` row and then **throws** for
per-agent gate failures (`budget.blocked`, `agent.not_invokable`, inactive company).
`tickTimers()` iterated agents with **no per-agent guard**, so the throw escaped the loop.
Consequences, every 30 seconds:

- every agent ordered **after** the blocked one silently stopped receiving heartbeats;
- `tickDueIssueMonitors` sits after the loop and therefore **never ran at all**.

One agent sitting over its budget hard-stop was enough to degrade scheduling for the whole
instance — and it does not self-clear, so this persists until someone raises the budget.
This is almost certainly the real user-visible "Paperclip is unresponsive" symptom, and it
is **application-level, not resource-level**.

That also explains the number below, which the first draft flagged as merely "worth a
separate look": `agent_wakeup_requests` recorded **245,426 `skipped`** rows in 7 days
(~35k/day, ~12 per 30-second tick) against 202 `completed`. Those are the durably-recorded
refusals from exactly this path.

**Fixed** in this branch: per-agent `try/catch` in `tickTimers`, with a regression test
(`server/src/__tests__/heartbeat-blocked-agent-isolation.test.ts`) that reproduces the
production error without the fix and passes with it.

One more incidental finding from reading that file: **`server.log` is 650 MB and
unrotated**, on the Longhorn volume, written continuously. Worth rotating — it is a
standing contributor to I/O on the very disk this report is about.

---

## Answers to the brief's numbered objectives

1. **Prior art.** `paperclip-perf-inbox-fix` carries the heartbeat hardening commits that
   correlate with timeouts dropping to ~zero in August. Also: `cnpg-cluster.yaml` lines
   62–66 already document *this exact symptom* and attribute it to CPU shares —
   "the instance manager could not answer /healthz inside the 5s liveness timeout, and CNPG
   restarted the instance (exit 0, never OOMKilled)" — and raised CPU 100m → 500m to fix
   it. **That fix targeted the wrong layer and the symptom persisted.**
2. **Throttling.** Settled and killed: 2.5–3.5%, enforced at the limit, node CPU idle-ish.
3. **Postgres.** Settled: healthy at every layer measured. `pg_stat_statements` unavailable.
4. **The CNPG restarts.** Explained: liveness `isolationCheck` failing on API-server
   unreachability during etcd stalls → kubelet SIGTERM → clean `exit 0`. Not memory, not
   crashes. The counters moved **3→4 and 6→7 during this session**; the brief's "9 restarts"
   is now 11 and still climbing.
5. **The timeouts.** Run-level timeouts stopped 2026-08-02. The live failure is
   `heartbeat timer tick failed` every 30 s — a budget hard-stop on one agent aborting the
   entire scheduling sweep (now fixed with a regression test) — plus ~181-second database
   blackouts during each failover.
6. **etcd co-location.** Yes — Paperclip should move off this node, but that is the
   *smaller* half of the problem. See below.
7. **Ranked verdict.** Above.

---

## Fixes, with expected effect

Ordered by (effect ÷ risk). None of these is "give Paperclip more CPU or memory".

| # | Fix | Where | Expected effect | Risk |
|---|---|---|---|---|
| 1 | Cut `smartShutdownTimeout` 180 → 20 s, **and** set a client-side `idle_timeout` / `max_lifetime` on the postgres.js pool so idle connections close | `cnpg-cluster.yaml`; `packages/db/src/client.ts` | Turns each failover from a **~181 s** outage into **< 25 s**. Biggest single win, and it does not depend on fixing the cluster. | Low |
| 2 | Raise `isolationCheck` `connectionTimeout`/`requestTimeout` 1000 → 5000 ms, or disable `isolationCheck` on a 2-instance cluster | `cnpg-cluster.yaml` | Stops transient 2.4–6.6 s API stalls from being read as "primary is dead". Should eliminate most of the 11 restarts. | Low |
| 3 | Log the real error in the heartbeat tick (`err` currently renders empty) | `server/src/index.ts:886` | Makes the one *currently firing* error diagnosable. Costs nothing. | None |
| 4 | Move Paperclip (and the other CNPG clusters) off `lue-and-naddy-mbp-old` | `lue-kube` node selectors | Removes Paperclip + pinchtab + Longhorn replica I/O from the etcd node, and gets Paperclip off a disk that is 8× slower than the worker's. | Medium — needs somewhere to go; cluster is at 88% memory requests. |
| 5 | Move Frigate off the etcd node | `k3s/apps/burrow/` | Frigate's continuous `ffmpeg` transcode + NVR writes were the largest non-Longhorn contributor visible in D-state. Likely the single biggest reduction in node iowait. | Medium — **Luke's call, another workload, explicitly out of scope for this lane.** |
| 6 | Fix the etcd topology: keep all three members on the LAN, or tune `heartbeat-interval`/`election-timeout` for a 25–60 ms RTT | `lue-kube` control plane | Addresses cause #3, which is load-independent. Without this the control plane stays fragile even on an idle node. | High — control-plane surgery, needs planning. |
| 7 | Install `pg_stat_statements` | `cnpg-cluster.yaml` `shared_preload_libraries` | Closes the one blind spot in this report. | Low (needs restart) |

### On resource right-sizing — the thing this lane was authorised to land

**I did not land a right-sizing PR, deliberately.** The brief permitted one, but the
measurements say it would not help and would mislead the next reader:

- `paperclip` averaged ~1.0 core over its lifetime against a 500m request, and `pinchtab`
  1,171 Mi against a 512 Mi request — so both requests *are* genuinely too low as
  bookkeeping, and raising them would improve scheduling honesty.
- But the node is **49.6% iowait at 19.8% user CPU** with `oom_kill 0`. Nothing is being
  killed or CPU-starved. Raising requests on a node that is already at **88% memory
  requests** would most likely make the pod unschedulable, or evict a neighbour — which the
  brief forbids.

Right-sizing here is hygiene, not a fix, and it should ride along with fix #4 (moving the
pod) rather than land on its own. Recommended values when that happens:
`paperclip` → `cpu 1000m / memory 1.5Gi`; `pinchtab` → `cpu 200m / memory 1.25Gi`.

---

## What I could not check

- **`pg_stat_statements`** — extension not installed; per-query latency unverified.
- **Outbound/external API call latency** — the Captain's list included this; the control
  plane went down twice while I was working and I prioritised capturing the live failover
  over instrumenting egress. Unmeasured, and therefore unranked.
- **Whether `cloud-pi` scaling to zero helped** — it landed (namespace is empty, node memory
  fell 10,955 Mi → 9,680 Mi, ~1.2 Gi freed as predicted), but the API server became
  unreachable before I could take the post-change throttling delta. Node free memory was
  still only 197 MB afterwards, so the ~1.2 Gi was reabsorbed rather than banked.
- **Per-process memory apportionment on the node** — SSH timed out on the final attempt.
  I can name Frigate and Longhorn as major I/O contributors from D-state sampling, but I
  do not have a clean RSS ranking to prove memory blame.
- No RBAC refusals were encountered. CNPG `Cluster` objects and the operator log read fine.

## Measurement hygiene note

One of my own commands (`journalctl` reading at 253 MB/s) materially polluted a load and
iostat sample, inflating load average to 98 and iowait to 67%. The corrected clean numbers
are load 24–60 and 49.6% iowait. I have flagged this inline rather than quietly dropping
the bad sample, because the same trap will catch the next person who SSHes into a node that
is already I/O-bound to diagnose why it is I/O-bound.
