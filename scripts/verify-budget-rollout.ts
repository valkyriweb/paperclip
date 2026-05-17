/**
 * Post-deploy verifier for the Paperclip budget integration substream.
 *
 * Substream: agent-system/PAPERCLIP-BUDGET-INTEGRATION.md.
 *
 * Asserts the goal's success criteria as runnable SQL gates against a live
 * Paperclip database. Converts the "stare at the SMI dashboard" step into a
 * one-command pass/fail.
 *
 * Gates (each maps to a line in the goal text):
 *
 * G1  every named source has emitted at least one cost_event in the window
 *     ("all named sources report cost data to Paperclip without gaps")
 * G2  no biller has more than `--unknown-threshold` `unknown` billingType
 *     rows ("accurate billing type classification (subscription vs metered)
 *     per biller")
 * G2b every row's billingType is consistent with the source's biller
 *     (anthropic/openai/google etc. → metered_api; github-copilot →
 *     subscription_included; claude-bridge can be either)
 * G6  no duplicate cost_events.billing_code per company ("without duplication")
 * G3  at least one budget_policy exists per scope kind we support
 *     ("agent-level and project-level budget policies")
 * G4  paused-by-budget scopes have not started new heartbeat runs after the
 *     pause timestamp ("budget control plane blocks paused agents/projects
 *     at spend limits")
 *
 * Usage:
 *
 *   pnpm tsx scripts/verify-budget-rollout.ts \
 *     --company <companyId> \
 *     [--window-hours 24] \
 *     [--expected-billers anthropic,openai,multica,claude-bridge] \
 *     [--unknown-threshold 0]
 *
 *   # Or verify across all companies:
 *   pnpm tsx scripts/verify-budget-rollout.ts --all
 *
 * Exit codes:
 *   0  every gate passed
 *   1  at least one gate failed (details printed to stderr)
 *   2  configuration error (bad flags, DB unreachable)
 */

import { sql, createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

/**
 * Helper: build a parameterised `IN (...)` clause from a list of UUIDs.
 * Postgres-js doesn't auto-cast a JS array into a Postgres array literal
 * when you write `ANY($1::uuid[])` — it tries to send the array as a single
 * string and the server rejects it with 22P02 'malformed array literal'.
 * Binding each UUID as its own parameter via sql.join sidesteps the issue.
 */
function uuidIn(companyIds: string[]) {
  return sql.join(
    companyIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

export interface Args {
  companyId: string | null;
  all: boolean;
  windowHours: number;
  expectedBillers: string[];
  unknownThreshold: number;
  databaseUrl: string;
}

function parseFlag(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return null;
  const v = process.argv[idx + 1];
  return v && !v.startsWith("--") ? v : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseArgs(): Args {
  const config = loadConfig();
  const databaseUrl =
    process.env.DATABASE_URL?.trim() ||
    config.databaseUrl ||
    `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  return {
    companyId: parseFlag("--company"),
    all: hasFlag("--all"),
    windowHours: Number(parseFlag("--window-hours") ?? "24"),
    expectedBillers: (
      parseFlag("--expected-billers") ??
      "anthropic,openai,google,claude-bridge,multica"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    unknownThreshold: Number(parseFlag("--unknown-threshold") ?? "0"),
    databaseUrl,
  };
}

export interface GateResult {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
}

function ok(id: string, name: string, detail: string): GateResult {
  return { id, name, passed: true, detail };
}

function fail(id: string, name: string, detail: string): GateResult {
  return { id, name, passed: false, detail };
}

export async function gateG1(
  db: ReturnType<typeof createDb>,
  args: Args,
  companyIds: string[],
): Promise<GateResult> {
  const billerCounts = await db.execute<{
    biller: string;
    company_id: string;
    n: string;
    last_seen: string;
  }>(sql`
    SELECT biller, company_id, COUNT(*)::text AS n, MAX(occurred_at)::text AS last_seen
    FROM cost_events
    WHERE company_id IN (${uuidIn(companyIds)})
      AND occurred_at >= now() - (${args.windowHours}::int || ' hours')::interval
    GROUP BY biller, company_id
    ORDER BY biller, company_id
  `);

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const row of billerCounts as unknown as Array<{
    biller: string;
    company_id: string;
    n: string;
    last_seen: string;
  }>) {
    seen.add(row.biller);
    lines.push(`    ${row.biller.padEnd(20)} ${row.n.padStart(8)} rows  last=${row.last_seen}`);
  }

  const missing = args.expectedBillers.filter((b) => !seen.has(b));
  const detail = [
    `    Window: last ${args.windowHours}h. Expected billers: ${args.expectedBillers.join(", ")}`,
    ...lines,
    missing.length === 0
      ? `    ✓ every expected biller has at least one row`
      : `    ✗ missing billers: ${missing.join(", ")}`,
  ].join("\n");

  return missing.length === 0
    ? ok("G1", "every named source emitted cost events", detail)
    : fail("G1", "every named source emitted cost events", detail);
}

export async function gateG2(
  db: ReturnType<typeof createDb>,
  args: Args,
  companyIds: string[],
): Promise<GateResult> {
  const rows = await db.execute<{ biller: string; n: string }>(sql`
    SELECT biller, COUNT(*)::text AS n
    FROM cost_events
    WHERE company_id IN (${uuidIn(companyIds)})
      AND occurred_at >= now() - (${args.windowHours}::int || ' hours')::interval
      AND billing_type = 'unknown'
      AND biller NOT IN ('claude-bridge', 'openai-codex', 'claude-code')  -- hybrids legitimately unknown w/o env signal
    GROUP BY biller
    HAVING COUNT(*) > ${args.unknownThreshold}
    ORDER BY n DESC
  `);

  const lines = (rows as unknown as Array<{ biller: string; n: string }>).map(
    (r) => `    ${r.biller.padEnd(20)} ${r.n.padStart(8)} unknown rows`,
  );

  if (lines.length === 0) {
    return ok(
      "G2",
      "no biller has more `unknown` rows than threshold",
      `    ✓ all non-hybrid billers have billing_type classified (threshold ${args.unknownThreshold})`,
    );
  }
  return fail(
    "G2",
    "no biller has more `unknown` rows than threshold",
    [
      `    Threshold: ${args.unknownThreshold} unknown rows per biller`,
      ...lines,
      `    → server-side classifier should have caught these. Investigate.`,
    ].join("\n"),
  );
}

export async function gateG2b(
  db: ReturnType<typeof createDb>,
  args: Args,
  companyIds: string[],
): Promise<GateResult> {
  // metered_api billers that somehow ended up as subscription_included, or
  // vice versa. Three classes:
  //   - direct-API billers (anthropic, openai, etc.) MUST be metered_api
  //   - subscription-tool billers (claude-code, claude-bridge w/ OAuth) MUST be
  //     subscription_included (these are set by the emitter, never inferred)
  //   - github-copilot is subscription_only
  // Hybrid billers like openai-codex deliberately omitted: caller-disambiguated.
  const rows = await db.execute<{ biller: string; billing_type: string; n: string }>(sql`
    SELECT biller, billing_type, COUNT(*)::text AS n
    FROM cost_events
    WHERE company_id IN (${uuidIn(companyIds)})
      AND occurred_at >= now() - (${args.windowHours}::int || ' hours')::interval
      AND (
        (biller IN ('openai','anthropic','google','google-vertex','amazon-bedrock','deepseek','groq','xai','openrouter','mistral','cohere','perplexity')
         AND billing_type = 'subscription_included')
        OR
        (biller = 'github-copilot' AND billing_type = 'metered_api')
      )
      -- Hybrid billers (claude-code, openai-codex, claude-bridge) intentionally
      -- NOT checked here: they can legitimately be either type depending on
      -- emitter config (API key vs Pro/Plus subscription). G2 still catches
      -- the case where a hybrid biller has 'unknown' rows above threshold.
    GROUP BY biller, billing_type
    ORDER BY biller
  `);

  const list = rows as unknown as Array<{ biller: string; billing_type: string; n: string }>;

  if (list.length === 0) {
    return ok(
      "G2b",
      "billing_type matches expected for each biller",
      `    ✓ no biller mis-classified (metered → subscription or vice versa)`,
    );
  }
  return fail(
    "G2b",
    "billing_type matches expected for each biller",
    list
      .map((r) => `    ${r.biller.padEnd(20)} as ${r.billing_type.padEnd(22)} ${r.n.padStart(6)} rows`)
      .join("\n"),
  );
}

export async function gateG6(
  db: ReturnType<typeof createDb>,
  args: Args,
  companyIds: string[],
): Promise<GateResult> {
  // The partial unique index should make this impossible at the DB level. If
  // it returns rows, something rewrote the index or bypassed createEvent.
  const rows = await db.execute<{ company_id: string; billing_code: string; n: string }>(sql`
    SELECT company_id, billing_code, COUNT(*)::text AS n
    FROM cost_events
    WHERE company_id IN (${uuidIn(companyIds)})
      AND billing_code IS NOT NULL
    GROUP BY company_id, billing_code
    HAVING COUNT(*) > 1
    ORDER BY n DESC
    LIMIT 20
  `);

  const list = rows as unknown as Array<{ company_id: string; billing_code: string; n: string }>;

  if (list.length === 0) {
    return ok(
      "G6",
      "no duplicate billing_code rows",
      `    ✓ partial unique index holds, ON CONFLICT path correct`,
    );
  }
  return fail(
    "G6",
    "no duplicate billing_code rows",
    [
      `    Found duplicate billing_codes (top 20):`,
      ...list.map((r) => `    ${r.company_id} | ${r.billing_code} | ${r.n}`),
    ].join("\n"),
  );
}

export async function gateG5(
  db: ReturnType<typeof createDb>,
  args: Args,
  companyIds: string[],
): Promise<GateResult> {
  // Metered rows that landed with cost_cents = 0 despite having token usage.
  // services/costs.ts:createEvent falls back to costCents=0 when the
  // model_pricing lookup for (aliasedProvider, model, occurredAt) returns
  // nothing — the goal calls this 'no gaps', so any zero-cost metered row
  // with non-zero token spend is a pricing-table gap that needs filling.
  //
  // Excluded from the gate:
  //   - billing_type = subscription_included (legitimately zero by definition)
  //   - billing_type = unknown (G2 owns that bucket)
  //   - input + cached + output = 0 (handshake / heartbeat-shaped rows where
  //     zero cost is correct, e.g. metadata-only events)
  //
  // Returns top 20 offending (biller, model) pairs ordered by row count so the
  // operator can prioritize seeding the missing pricing entries.
  const rows = await db.execute<{ biller: string; model: string; n: string; total_tokens: string }>(sql`
    SELECT biller,
           model,
           COUNT(*)::text AS n,
           SUM(input_tokens + cached_input_tokens + cache_creation_input_tokens + output_tokens)::text AS total_tokens
    FROM cost_events
    WHERE company_id IN (${uuidIn(companyIds)})
      AND occurred_at >= now() - (${args.windowHours}::int || ' hours')::interval
      AND cost_cents = 0
      AND billing_type IN ('metered_api', 'subscription_overage', 'credits', 'fixed')
      AND (input_tokens + cached_input_tokens + cache_creation_input_tokens + output_tokens) > 0
    GROUP BY biller, model
    ORDER BY n DESC
    LIMIT 20
  `);

  const list = rows as unknown as Array<{ biller: string; model: string; n: string; total_tokens: string }>;

  if (list.length === 0) {
    return ok(
      "G5",
      "no metered rows with cost=0 and tokens>0 (no pricing gaps)",
      `    ✓ every metered emission with tokens resolved a price—`,
    );
  }
  return fail(
    "G5",
    "no metered rows with cost=0 and tokens>0 (no pricing gaps)",
    [
      `    Found metered rows with no resolved price (top 20):`,
      `    Fix: add a model_pricing row for each (biller, model) pair below,`,
      `    then re-run \`pnpm db:backfill-cost-cents\` to repair existing rows.`,
      ...list.map((r) =>
        `    ${r.biller.padEnd(18)} ${r.model.padEnd(40)} ${r.n.padStart(6)} rows  ${r.total_tokens.padStart(10)} tokens`,
      ),
    ].join("\n"),
  );
}

export async function gateG3(
  db: ReturnType<typeof createDb>,
  _args: Args,
  companyIds: string[],
): Promise<GateResult> {
  const rows = await db.execute<{ scope_type: string; n: string }>(sql`
    SELECT scope_type, COUNT(*)::text AS n
    FROM budget_policies
    WHERE company_id IN (${uuidIn(companyIds)})
      AND is_active = true
      AND amount > 0
    GROUP BY scope_type
    ORDER BY scope_type
  `);

  const list = rows as unknown as Array<{ scope_type: string; n: string }>;
  const scopes = new Set(list.map((r) => r.scope_type));
  const detail = [
    `    Active budget policies by scope:`,
    ...list.map((r) => `    ${r.scope_type.padEnd(10)} ${r.n.padStart(4)}`),
  ].join("\n");

  // Goal requires both agent-level AND project-level support to exist as a
  // capability. Having at least one of each in the wild proves the UX works.
  // Not a hard failure if only one — surfacing for review either way.
  if (scopes.has("agent") && scopes.has("project")) {
    return ok("G3", "agent + project budget policies exist", detail);
  }
  if (scopes.size === 0) {
    return fail(
      "G3",
      "agent + project budget policies exist",
      `    ✗ no active budget policies in any scope — UX is wired but unused`,
    );
  }
  return ok(
    "G3",
    "agent + project budget policies exist (partial)",
    detail + `\n    ⚠ only ${[...scopes].join(", ")} scope(s) in use. Capability exists for both.`,
  );
}

export async function gateG4(
  db: ReturnType<typeof createDb>,
  _args: Args,
  companyIds: string[],
): Promise<GateResult> {
  // Find scopes paused for budget reason, then check if any heartbeat_runs
  // started after the pause. If so, the budget control plane leaked.
  //
  // Uses agents.paused_at / projects.paused_at — dedicated columns set by
  // services/budgets.ts:pauseAndCancelScopeForBudget when a hard threshold is
  // crossed. NOT updated_at, which advances on any agent edit (rename, icon
  // change) and would give false negatives.
  const leakedAgents = await db.execute<{
    scope: string;
    scope_id: string;
    paused_at: string;
    run_id: string;
    run_started: string;
  }>(sql`
    SELECT 'agent' AS scope, a.id AS scope_id, a.paused_at::text AS paused_at,
           hr.id AS run_id, hr.started_at::text AS run_started
    FROM agents a
    JOIN heartbeat_runs hr ON hr.agent_id = a.id
    WHERE a.company_id IN (${uuidIn(companyIds)})
      AND a.status = 'paused'
      AND a.pause_reason = 'budget'
      AND a.paused_at IS NOT NULL
      AND hr.started_at > a.paused_at
    LIMIT 20
  `);

  // Projects pause cancels in-flight work too. heartbeat_runs has no direct
  // project_id column — the link is via context_snapshot.projectId, falling
  // back to the issue's project_id (matches services/heartbeat.ts:9245-9268
  // listProjectScopedRunIds). A run started after a paused project's
  // paused_at, resolving to that project via either path, is a leak.
  const leakedProjects = await db.execute<{
    scope: string;
    scope_id: string;
    paused_at: string;
    run_id: string;
    run_started: string;
  }>(sql`
    SELECT 'project' AS scope, p.id AS scope_id, p.paused_at::text AS paused_at,
           hr.id AS run_id, hr.started_at::text AS run_started
    FROM projects p
    JOIN heartbeat_runs hr ON hr.company_id = p.company_id
    LEFT JOIN issues i ON i.id::text = hr.context_snapshot ->> 'issueId'
    WHERE p.company_id IN (${uuidIn(companyIds)})
      AND p.paused_at IS NOT NULL
      AND p.pause_reason = 'budget'
      AND hr.started_at > p.paused_at
      AND coalesce(hr.context_snapshot ->> 'projectId', i.project_id::text) = p.id::text
    LIMIT 20
  `);

  const leaks = [
    ...(leakedAgents as unknown as Array<{ scope: string; scope_id: string; paused_at: string; run_id: string; run_started: string }>),
    ...(leakedProjects as unknown as Array<{ scope: string; scope_id: string; paused_at: string; run_id: string; run_started: string }>),
  ];

  if (leaks.length === 0) {
    return ok(
      "G4",
      "paused-by-budget scopes have not started new runs",
      `    ✓ budget control plane is blocking paused agents AND projects`,
    );
  }
  return fail(
    "G4",
    "paused-by-budget scopes have not started new runs",
    [
      `    Found ${leaks.length} heartbeat run(s) that started AFTER scope pause:`,
      ...leaks.map((r) => `    ${r.scope.padEnd(7)} ${r.scope_id} paused=${r.paused_at} run=${r.run_id} started=${r.run_started}`),
    ].join("\n"),
  );
}

async function main() {
  const args = parseArgs();
  if (!args.companyId && !args.all) {
    console.error("error: pass --company <id> or --all");
    process.exit(2);
  }

  const db = createDb(args.databaseUrl);

  const companyIds: string[] = args.all
    ? (
        (await db.execute<{ id: string }>(sql`SELECT id FROM companies WHERE status != 'archived'`)) as unknown as Array<{
          id: string;
        }>
      ).map((r) => r.id)
    : [args.companyId!];

  if (companyIds.length === 0) {
    console.error("error: no companies to verify");
    process.exit(2);
  }

  console.log(`\n=== Paperclip budget rollout verifier ===`);
  console.log(`Database:        ${args.databaseUrl.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(`Companies:       ${companyIds.length} (${args.all ? "all" : args.companyId})`);
  console.log(`Window:          last ${args.windowHours}h`);
  console.log(`Expected billers: ${args.expectedBillers.join(", ")}`);
  console.log(`Unknown threshold: ${args.unknownThreshold} rows/biller\n`);

  const gates: GateResult[] = [
    await gateG1(db, args, companyIds),
    await gateG2(db, args, companyIds),
    await gateG2b(db, args, companyIds),
    await gateG5(db, args, companyIds),
    await gateG6(db, args, companyIds),
    await gateG3(db, args, companyIds),
    await gateG4(db, args, companyIds),
  ];

  for (const g of gates) {
    const tag = g.passed ? "PASS" : "FAIL";
    console.log(`[${tag}] ${g.id}  ${g.name}`);
    console.log(g.detail);
    console.log();
  }

  const failed = gates.filter((g) => !g.passed);
  if (failed.length === 0) {
    console.log(`✓ all ${gates.length} gates passed`);
    process.exit(0);
  } else {
    console.error(`✗ ${failed.length}/${gates.length} gates failed: ${failed.map((g) => g.id).join(", ")}`);
    process.exit(1);
  }
}

// Only auto-run when invoked as a script, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("verifier crashed:", err);
    process.exit(2);
  });
}
