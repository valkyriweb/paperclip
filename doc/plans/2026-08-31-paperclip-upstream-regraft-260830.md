# Paperclip upstream regraft — 2026-08-31

## Scope and immutable inputs

This ledger records the semantic sync of `valkyriweb/paperclip` with the
upstream target `paperclipai/paperclip`.

- **B (last integrated upstream base):** `213dabab4f8e1f3bb1803a2924c0fea1289fcd4c`
- **L (fork head before this sync):** `59b1aa9fbcaa2a94db4ed43001bbf2e28e1fdba6`
- **U (reviewed upstream target):** `d1abff25671b2526e1ac71fd5240039780a7cdac`
- **Current upstream fetch observation:** `upstream/master` was
  `001428a2d6253e9857a3562537a635561e64d040`; it is a descendant of U and was
  not substituted for the requested immutable target.
- **Operation:** explicit-B semantic three-way reconciliation, materialized as a
  normal merge result. No history rewrite has been performed.

## Disposition ledger

The initial explicit-B review covered 162 conflict paths. The final staged tree
has no unmerged index entries and no conflict markers.

| Area | Disposition | Preserved intent or reason |
| --- | --- | --- |
| Upstream core API, UI, adapters, plugins, docs, and tests | Adopt | Take compatible upstream V1 behavior and contracts. |
| Fork heartbeat concurrency and ownership fencing | Adapt | Keep transactional admission, owner-token/fence CAS writes, lease revalidation, retry/supersession, retention, and recovery safeguards; enforce `maxDailyRuns` inside the per-agent advisory-lock claim transaction. |
| Recovery and stale-run evaluation | Adapt | Preserve routine/paused suppression, source-scoped recovery, stale-run issue creation only for explicit scans, and cooldown/idempotency behavior. |
| Execution workspaces and runtime exposure | Adapt | Preserve company scoping, authorization, lifecycle fencing, cleanup/reopen safety, canonical paths, loopback diagnostics, deterministic valid port pairs, and no cross-workspace residue. |
| Fork billing and provider behavior | Adapt | Retain Pi/OpenClaw billing-type resolution, cumulative-session delta accounting, cache buckets, explicit ClawRouter cost precedence, and fork model-rate coverage. |
| Fork OpenClaw/provider protocol behavior | Adapt | Preserve provider fallback, keep-alive, protocol v4, and workspace-finalize FK-race behavior. |
| Database migrations `0212–0218` | Preserve | These deployed fork migrations remain byte-for-byte and in their original order. |
| Upstream migrations after the fork range | Adapt | Shift 22 upstream migrations to `0219–0240`; snapshots and journal entries remain ordered and migration checks pass. |
| Fork CI and Docker/deploy overlays | Adapt | Keep fork owner guards, amd64/deploy behavior, Invoicegen integration, and sync-branch lockfile policy. Add the native-install compiler prerequisite and pinned Rust toolchain needed by the merged build. Reject the upstream-only trusted-runner reusable workflow in favor of the fork's guarded direct PR workflow. |
| Commitperclip advisory gate | Adopt upstream removal | Upstream removed the heuristic draft-advisory security gate because it generated untriaged noise; the workflow no longer invokes it, while quality, dependency, release-bootstrap, migration-order, co-author, and repository security controls remain. |
| Paperclip Runner | Defer/guard | Upstream Runner code and contracts are present, but adapter exposure remains disabled by default and requires explicit rollout/configuration. No automatic activation. |
| Upstream Apps/Connections/delegation and release-registry publishing | Defer/reject for fork | Preserve fork CI guards and do not enable upstream-only publish, registry, canary, or account-side behavior. |
| Upstream changes superseded by existing fork behavior | Equivalent | Do not duplicate behavior where the fork already supplies the invariant; retain focused tests. |

## Required invariants

- Company and actor boundaries remain enforced.
- Heartbeat run admission and ownership writes remain transactional and fenced.
- Approval, budget hard-stop, activity-log, single-assignee, and issue checkout
  invariants remain intact.
- Native Runner is not enabled by default.
- No production deployment, migration, package publish, registry release,
  account change, or live Paperclip mutation is part of this work.

## Verification ledger

Completed before commit:

- Migration numbering and safety checks: pass.
- Upstream migration byte comparisons and journal review: pass; historical holes
  and the pre-existing duplicate journal index `178` for tags `0177`/`0178`
  are retained rather than renumbered. The duplicate is present in U as well,
  and the installed node-postgres migrator resolves entries by tag/file, not
  journal index.
- Repository typecheck: pass.
- Server startup feedback focused suite: 18/18 pass.
- Exposure and loopback focused suites: 42/42 pass.
- Company-skills focused suite: 57/57 pass.
- Reconciliation focused suites: 200/200 pass.
- Locale/path/CLI/worktree focused fixes: recorded in the sync session and
  rerun successfully where noted.
- UI focused suites: 76/76 pass.
- Token gates: pass.
- Staged and unstaged whitespace checks: pass.
- Atomic daily-cap regression: 2/2 pass; a concurrent claim pair admits one
  run and returns one daily-cap block.
- Fresh full-suite pass: `pnpm test:run` exited 0 after 1,403 passing test-file
  results and 15,618 passing tests (42 skipped tests and 3 skipped files).
  Earlier serialized flakes were isolated and fixed or rerun successfully.
- Skills-catalog focused tests: 9/9 pass, including the GitHub contents-API
  fallback for a raw pinned-file 400.
- Repository typecheck rerun: pass.
- Repository build rerun: pass; the catalog builder now falls back to the
  GitHub contents API when a raw pinned file returns HTTP 400.
- Workflow wiring and shard tests: 28/28 pass after retaining the fork's
  guarded direct PR workflow.
- Independent reviews: CI/supply-chain, heartbeat/recovery, workspace
  security, and final staged-tree review completed; the final review's
  trusted-workflow finding was resolved by rejecting the upstream-only
  reusable workflow and restoring the fork PR guard.

Still required before commit and PR disposition:

- Commit, push, preserve the unrelated protected PR #133, and open/update a
  dedicated reconciliation PR; accept only exact-head green CI plus
  independent review.
- Validate Docker when a daemon is available; local Docker remains blocked.
- Revalidate the immutable target and exact final head after push.

## External validation notes

Local Docker validation is blocked because the Docker daemon is unavailable.
Upstream Docker attempts for the pinned upstream target and nearby immutable
commits failed during native `cpu-features` compiler detection. The fork
Dockerfile now installs `build-essential` in the dependency stage before
`pnpm install` and pins Rust toolchain `1.88.0`; this must be validated by a
working Docker build or exact-head CI.

**Current disposition:** uncommitted and not deployed. Do not merge until the
remaining checks and review gates are green.
