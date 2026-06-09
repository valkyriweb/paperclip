# CI Review Personas Shakedown — 2026-06-10

**Target diff:** PR #19 `feat(otel): wire OpenTelemetry SDK with schema-compliant resource attributes`
**Branch:** `feat/otel-instrumentation` vs `origin/bermont`
**Commits reviewed:** `cd83819b7` (the unique otel commit; `d0402f831` is a merge of bermont into the feature branch — all other apparent changes in a `bermont...feat/otel-instrumentation` three-dot diff originate from bermont-merged commits, not this PR's work)

**Actual PR file surface (4 files, 169 lines added):**
- `server/src/otel.ts` — new, 78 LOC
- `server/src/__tests__/otel.test.ts` — new, 83 LOC
- `server/package.json` — 7 new otel dep lines
- `server/src/index.ts` — 1 line: `import './otel.js'`

**Orchestrator role:** applying each persona's lens in sequence, adversarially verifying every claim before recording it.

---

## Persona findings

### RELIABILITY

```
RELIABILITY findings: 1

P3:
- server/src/otel.ts:75 — SDK shutdown only hooked to SIGTERM/SIGINT; uncaught exceptions, process.exit() calls from other modules, and normal beforeExit will not flush buffered telemetry. Loss of the final seconds of spans/metrics on crash or non-signal exit is the consequence. Low-probability in k8s (SIGTERM is the standard kill) but worth noting.
```

Adversarial check: `otel.ts:73` calls `sdk.start()` — OTel Node SDK buffers spans and flushes on a periodic interval (configurable, default 5s). SIGTERM/SIGINT are handled. The `sdk.shutdown()` promise resolves after in-flight flushes. No `process.on('beforeExit')` or `process.on('uncaughtException')` guard exists. Verified in the file — the P3 is real but the P2 threshold (external call without timeout) is not met here because the SDK has its own internal timeouts and the exporter has a configurable timeout defaulting to 10s.

No P2 reliability findings. The health-check `withTimeout` in the bermont-merged work is well-structured with `timer.unref()` and proper cleanup.

---

### SECURITY

```
SECURITY findings: 0
```

Adversarial check:
- No hardcoded secrets. All config via `process.env`.
- `applyResourceAttributes` mutates `process.env` — this is intentional OTel bootstrapping pattern (seeding env vars before the SDK env resource detector runs). The values written are non-sensitive telemetry metadata.
- The `OTEL_EXPORTER_OTLP_ENDPOINT` env var is consumed directly as the exporter URL (`${endpoint}/v1/traces`). No SSRF risk beyond what the operator already controls by setting this env var — this is legitimate operator-configured telemetry routing, not user-supplied input.
- No auth tokens in otel.ts (OTLP auth header support is not added here, which is fine — the initial wire-up defers bearer-token/mTLS to follow-on work per the umbrella TELEMETRY-SCHEMA.md design).
- No PII or billing data exposed in telemetry spans (no span attribute injection at this level).

---

### SCOPE-CREEP

```
SCOPE-CREEP findings: 0
```

Adversarial check: The PR scope is "wire OTel SDK + resource attributes." All 4 changed files are directly on that path:
- `otel.ts` — the SDK init module
- `otel.test.ts` — tests for the new module
- `package.json` — new runtime deps the module requires
- `index.ts` — the bootstrap import

No drive-by changes to unrelated subsystems. The bermont-merged commits (health, heartbeat, costs, hostname-guard, CI shards) pre-exist on bermont and are not part of this PR's authorship.

---

### DOCS-COVERAGE

```
DOCS-COVERAGE findings: 2

P2:
- server/package.json:48 — @opentelemetry/exporter-logs-otlp-http is added as a production dependency but is never imported in server/src/otel.ts or anywhere else in the branch. An unused production dep ships in the container image and widens the attack/audit surface with no benefit.

P3:
- server/src/otel.ts:1 — Five new env vars are introduced (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_LOG_LEVEL, PAPERCLIP_DEPLOYMENT_ENV, PAPERCLIP_AGENT_SURFACE, PAPERCLIP_AGENT_ROLE) but no corresponding entries appear in docs/ or any environment-variable reference. The OTEL_* vars are OTel-standard; the PAPERCLIP_* vars are Paperclip-specific and operators will need to know them to override defaults.
```

Adversarial check on P2: grepped `otel.ts` — imports are `NodeSDK`, `getNodeAutoInstrumentations`, `OTLPTraceExporter`, `OTLPMetricExporter`, `PeriodicExportingMetricReader`, `diag/DiagConsoleLogger/DiagLogLevel`. The `@opentelemetry/exporter-logs-otlp-http` package is present in `server/package.json` line 48 but has zero corresponding import. Confirmed P2.

Adversarial check on P3: `PAPERCLIP_DEPLOYMENT_ENV`, `PAPERCLIP_AGENT_SURFACE`, `PAPERCLIP_AGENT_ROLE`, `PAPERCLIP_DB_POOL_MAX`, `PAPERCLIP_DB_CONNECT_TIMEOUT_S`, `PAPERCLIP_DB_IDLE_TIMEOUT_S`, `PAPERCLIP_HEALTH_DB_TIMEOUT_MS` are all new env vars across this overall diff. No doc update in `docs/`. The PAPERCLIP_* vars are custom to this deployment and undiscoverable without reading source. P3 (non-blocking) because the project has no current env-var reference doc, so there's no existing surface to fall out of sync.

---

### CODEBASE-SHAPE

```
CODEBASE-SHAPE findings: 0
```

Adversarial check:
- `otel.ts` is 78 LOC — well under 500 LOC.
- `otel.test.ts` is 83 LOC — tests are exempt from the LOC check.
- Module boundary: `server/src/otel.ts` is a server-internal module, no cross-package reach. Imports only from `@opentelemetry/*` published packages.
- Public interface: 3 exported functions (`buildResourceAttributes`, `serializeResourceAttributes`, `applyResourceAttributes`) + 1 top-level side-effectful import. The public surface is small relative to the file size.
- No new abstractions with single callers: `buildResourceAttributes` is called by `applyResourceAttributes` and by 3 test suites. `applyResourceAttributes` is called at module init + by tests. Functions earn their separation.
- No dead exports detected.

---

### BUILD-HYGIENE

```
BUILD-HYGIENE findings: 2

P2:
- server/package.json:48 — @opentelemetry/exporter-logs-otlp-http is added as a production dep but is unused in the codebase (no import found in any file on the otel branch). This ships dead weight in the Docker image.

P3:
- server/package.json (otel deps block) — No CHANGELOG.md entry for this server/ change. CHANGELOG.md does not exist in this repository (neither on bermont nor on feat/otel-instrumentation), so this is a repo-wide gap rather than a miss on this PR specifically.
```

Adversarial check on Dockerfile drift: No new workspace `packages/*` directory was added — only `server/src/otel.ts` and deps in `server/package.json`. The Dockerfile COPY block for `server/package.json` already exists. No Dockerfile update required. No drift.

Adversarial check on CHANGELOG: `git show origin/feat/otel-instrumentation:CHANGELOG.md` returns nothing — the file does not exist in the repo. Gap is pre-existing; this PR didn't introduce it.

---

## P1/P2 real issues summary

Only one issue clears the P2 bar after adversarial verification:

**P2 — Unused production dependency `@opentelemetry/exporter-logs-otlp-http`**
- `server/package.json:48`
- The package is listed in `dependencies` but has zero imports across all files on the branch (`grep -r "exporter-logs-otlp-http"` → no hits).
- Ships in the production container image, widens npm audit surface, and costs install time.
- Fix: remove the line, or add the logs exporter wire-up as follow-on work.

No other P2s were found across all six lenses after adversarial verification.

---

## Verdict: do these personas produce signal?

**Yes, with qualifications.** Compared to the openclaw-claude shakedown incident format:

| Dimension | openclaw-claude baseline | paperclip otel shakedown |
|---|---|---|
| True P2 positives | ✓ found real issues | 1 real P2 (unused dep) |
| False positives | Some on scope confusion | 0 — diff scope clarification eliminated 14 of 18 apparent files as bermont-merged, keeping review focused |
| False negatives | — | Potential: OTEL endpoint URL injection (dismissed — operator-controlled env) |
| P3 signal value | Mixed | P3s are genuine: telemetry-loss on crash, undocumented env vars |
| Format adherence | ✓ | ✓ — per-persona structure produces parseable output |

**Key lesson:** The `git diff bermont...feature` three-dot form against a local bermont ref that lags origin/bermont produces a bloated 18-file diff that obscures the actual PR surface (4 files). The orchestrator must resolve remote refs before diffing. Recommend adding this to `reviewer-orchestrator.md`.

---

## Tuning recommendations

1. **reviewer-orchestrator.md — remote-ref normalization:** Before diffing, resolve the base branch to its remote ref (`origin/<base>`) explicitly. A stale local tracking branch poisons the diff.

2. **persona-scope-creep.md — merge-commit handling:** When the diff includes merge-of-base commits, the scope-creep persona should note these separately and exclude them from its finding surface. Add a note: "Verify the diff base is the remote tracking ref, not a local stale ref."

3. **persona-docs-coverage.md — env var inventory:** Add a check for new `process.env.*` usages in the diff that don't appear in an existing env var reference doc. The Paperclip-specific env vars (PAPERCLIP_*) are a real docs gap pattern.

4. **persona-build-hygiene.md — unused-dep check:** Add a rule: "New dep in package.json with no corresponding `import` anywhere in the diff's changed files → P2." The logs-otlp case shows this fires on real PRs.

5. **All personas — diff scope note:** Include the actual file count in the findings header so reviewers can quickly assess whether the diff was narrow or sprawling.
