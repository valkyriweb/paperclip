# CI Review Personas

## What this is

Six AI reviewer personas that automatically fan out over every PR diff and return structured findings. An orchestrator agent runs them in parallel and posts a single aggregated comment.

The system is advisory: it never blocks merges. Findings are P2 (should-fix before merge) or P3 (non-blocking notes). The verdict (`BLOCK`, `PASS WITH NOTES`, `PASS`) is guidance, not enforcement.

## Origin

Ported from `openclaw-claude` where the system was validated on 2026-05-01. The shakedown caught a layered-Dockerfile COPY drift that would have broken a from-scratch Docker build on the next deploy. See [Shakedown sample](#shakedown-sample) below for Paperclip's own first run.

## The 6 personas

| Persona | Blocking? | Focus |
|---|---|---|
| **reliability** | yes | Timeouts, retries, idempotency, failure paths. Paperclip-specific: `cost_events` idempotency, budget enforcement fallbacks, approval flow locking. |
| **security** | yes | Secret leaks, injection, auth gaps, CVEs. Paperclip-specific: billing data exposure, budget bypass, tenant isolation. |
| **scope-creep** | advisory | Orthogonal changes beyond the linked issue. Requires scope context (PR description). |
| **docs-coverage** | advisory | Env vars, config keys, public API changes without docs. Paperclip-specific: `config.json` schema fields, adapter package docs. |
| **codebase-shape** | yes | File size (500 LOC), complexity (function > 100 LOC / CC > 15), dep cycles, shallow modules. |
| **build-hygiene** | yes | Dockerfile/workspace drift, CHANGELOG gaps, release script consistency. |

**Blocking** means a P2 from that persona sets verdict to `BLOCK`. **Advisory** means P2 only sets verdict to `PASS WITH NOTES`.

## CI wiring

The workflow lives at `.github/workflows/ci-persona-review.yml`. It triggers on every non-draft PR opened/updated against `master` or `bermont`, runs the `reviewer-orchestrator` Claude Code agent, and posts the result as a PR comment.

### Required setup

1. Generate a Claude Code OAuth token at <https://code.claude.ai> → Account → API tokens.
2. Add it as a repository secret named `CLAUDE_CODE_OAUTH_TOKEN` (Settings → Secrets and variables → Actions).

That's the only manual step. The workflow uses `anthropics/claude-code-action@v1` on a standard GitHub-hosted runner — no self-hosted runner or `pi` installation needed.

### Self-hosted runner variant (advanced)

If a runner with `pi` + `claude-bridge` is available (see `openclaw-claude` docs for setup), replace the `anthropics/claude-code-action` step with the `pi-pr-review` script from `agent-scripts/skills/rusty-review/scripts/`. That path routes through the Claude subscription and is lower-latency for large diffs.

## Invoking manually

From any Claude Code session in this repo, paste:

```
Run the reviewer-orchestrator agent on diff HEAD~3..HEAD
```

Or with a specific PR:

```
Run the reviewer-orchestrator agent on PR #42
```

The orchestrator will fan out all 6 personas and return the REVIEW SUMMARY.

## Tuning a persona

Each persona is a Claude Code agent definition under `.claude/agents/`. To tune:

1. Edit the relevant `persona-<name>.md` file.
2. Adjust the "What I flag" and "What I don't flag" sections.
3. Commit. The change takes effect on the next PR trigger.

Keep findings anchored in real failure modes. Theoretical risks that never manifest make the signal-to-noise ratio degrade and reviewers stop reading.

## Shakedown sample

First run against `HEAD~5..HEAD` (commits: `f0b67e60`, `431d7a4e`, `66ab740e`, `44f77e22`, `86e7d2f8`). Run 2026-06-10.

```
REVIEW SUMMARY
diff: HEAD~5..HEAD (5 commits: fix(health) / test(issues) / feat(openclaw-gateway) / feat(adapters) / chore(ci))
scope: none

Findings: 8 P2 / 5 P3
Verdict: BLOCK

P2 (blocking):
- [reliability] packages/adapters/openclaw-gateway/src/server/execute.ts:1746 — waitSliceMs can exceed remaining deadline on final poll iteration; floor of 1_000ms means a 500ms waitTimeoutMs overshoots before the remaining<=0 guard fires. Adds latency on short-timeout paths.
- [reliability] packages/adapters/openclaw-gateway/src/server/execute.ts:1492 — Loop-guard abort relies on activeClient.close() triggering a throw caught by the outer handler; if the WS client resolves normally before the close lands, the abort silently no-ops until the next while iteration. Control-flow is implicit and fragile.
- [reliability] packages/db/src/client.ts:1217 — Caller-supplied options spread after pool-bound defaults, making the resource-pressure protection silently opt-out at any call-site. The fix can be undone by any caller passing options.
- [reliability] server/src/routes/health.ts:1331 — PAPERCLIP_HEALTH_DB_TIMEOUT_MS=0 falls through to 2500ms default via falsy || coercion; intentional disable is indistinguishable from unset.
- [docs-coverage] packages/db/src/client.ts:1212 — Three new env vars (PAPERCLIP_DB_POOL_MAX, PAPERCLIP_DB_CONNECT_TIMEOUT_S, PAPERCLIP_DB_IDLE_TIMEOUT_S) with no documentation. Operators cannot discover or tune pool bounds.
- [docs-coverage] server/src/routes/health.ts:1330 — PAPERCLIP_HEALTH_DB_TIMEOUT_MS introduced with no docs entry; only discoverable via source inspection.
- [docs-coverage] packages/adapters/openclaw-gateway/src/server/execute.ts:1742 — Six new adapter config keys (maxConnectAttempts, retryBackoffMs, retryBackoffCapMs, loopGuardEnabled, loopGuardWindow, loopGuardThreshold) with no adapter docs update.
- [build-hygiene] CHANGELOG.md — Not updated despite four source-layer changes in server/ and packages/. (also flagged by: docs-coverage)
- [codebase-shape] packages/adapters/openclaw-gateway/src/server/execute.ts — execute() now owns five distinct concerns with cyclomatic complexity well above 15. High-risk for future modifications.

P3 (non-blocking):
- [reliability] packages/adapters/openclaw-gateway/src/server/execute.ts:1765 — Loop-guard window resets on every reconnect; looping run surviving multiple drops can avoid threshold.
- [reliability] packages/adapters/openclaw-gateway/src/server/execute.resilience.test.ts:643 — Loop-guard test uses waitTimeoutMs:8_000; CI waits up to 8s if guard fails to fire.
- [docs-coverage] server/src/middleware/private-hostname-guard.ts:1310 — Health-route bypass of private-hostname guard is permanent policy with no durable docs entry.
- [codebase-shape] packages/adapters/openclaw-gateway/src/server/execute.ts:1766 — loopFailure closure captures mutable outer-scope state rather than taking explicit arguments.
- [build-hygiene] .github/workflows/release-smoke.yml:115 — Uses --no-frozen-lockfile while e2e.yml uses --frozen-lockfile; smoke may run against different dep versions.

Per-persona counts:
- reliability: 4 P2 / 2 P3
- security: 0 P2 / 0 P3
- scope-creep: skipped (no scope)
- docs-coverage: 4 P2 / 1 P3
- codebase-shape: 2 P2 / 1 P3
- build-hygiene: 1 P2 / 1 P3
```

**What the shakedown found:** The strongest signal was docs-coverage — three new env vars and six new adapter config keys shipped with no documentation. The build-hygiene persona also caught a missing CHANGELOG entry across four source-layer changes, and reliability flagged a subtle `options` spread ordering that makes the resource-pressure protection opt-out. Security came back clean.
