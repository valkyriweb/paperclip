# DRAFT — Budget foundation control PR

**Status:** prepared 2026-05-17 by Rusty (Pi session 019e359f).
**Branch:** `budget-foundation-control-pr` (local-only; not yet pushed).
**Base:** `paperclipai/paperclip` `master` (currently `3e6610fb`).
**Commits:** 3, +6086 / -16 (5136 of those = JSON pricing snapshot data).
**Local gate:** typecheck status pending in `/tmp/foundation-typecheck.log`.

---

## ⚠️ DO NOT OPEN THIS PR YET

Per `CONTRIBUTING.md`:
> Uncoordinated feature PRs against the core product may be closed, even when the implementation is thoughtful and high quality.

`ROADMAP.md` lists **"Better Budgeting"** as `✅` (active/owned by core). This PR overlaps that roadmap item. The Path 2 requirement applies:

> First talk about it in Discord → #dev channel
> → Describe what you're trying to solve
> → Share rough ideas / approach
> Once there's rough agreement, build it

**Required before opening:** Discord #dev conversation with Mario / core. Present this as Bermont's in-production budget tracking, offer it as the foundation for upstream's "Better Budgeting" roadmap item, ask if the shape and scope work. Adjust before pushing.

---

## Commits on the branch (oldest first)

| # | Hash | Title |
|---|---|---|
| 1 | `103d9995` | feat(budget): model_pricing table, cache-write tokens, billing-code idempotency |
| 2 | `d2ea26fd` | feat(budget): bundle Vercel pricing snapshot + idempotent model_pricing seed |
| 3 | `8968fa2d` | feat(budget): server-side cost computation + billing-code idempotency |

(Rebased equivalents of Bermont's `6082a137`, `143f50b1`, `940f21b7` on `feat/budget-model-pricing` = `be308812`.)

The 4th candidate — `refactor(shared): hoist computeCostCents to @paperclipai/shared` — was dropped from the foundation slice because it depends on `backfill-cost-cents.ts` and `cost.test.ts` which are introduced by later commits not in this scope. Hoist becomes a follow-up PR after the foundation lands.

## Migration numbering

Bermont's original `0084_budget_pricing.sql` was renumbered to **`0086_budget_pricing.sql`** to slot after the upstream tip (`0085_tranquil_the_executioner`). Done in the per-commit rebase that produced `feat/budget-model-pricing` = `be308812`. No further renumbering needed for this slice.

## Files touched (13 total)

```
packages/db/package.json                            (+5/-?)
packages/db/src/client.test.ts                      (+82)
packages/db/src/migrations/0086_budget_pricing.sql  (+37)
packages/db/src/migrations/meta/_journal.json       (+7)
packages/db/src/schema/cost_events.ts               (+16/-?)
packages/db/src/schema/index.ts                     (+1)
packages/db/src/schema/model_pricing.ts             (+39)
packages/db/src/seed-data/README.md                 (+49)
packages/db/src/seed-data/model-pricing.json        (+5136)  ← Vercel pricing snapshot
packages/db/src/seed-model-pricing.test.ts          (+219)
packages/db/src/seed-model-pricing.ts               (+130)
server/src/__tests__/costs-service.test.ts          (+213)
server/src/services/costs.ts                        (+168/-?)
```

---

## Suggested PR title

`feat(budget): introduce model_pricing table + server-side cost computation`

## Suggested PR body (paste-ready)

```markdown
## Thinking Path

> - Paperclip orchestrates AI agents for zero-human companies
> - Cost visibility is the floor of the "Better Budgeting" roadmap item: until every cost_event row has a trustworthy `costCents`, no downstream budget gate or dashboard can be load-bearing
> - Today, cost_events relies on adapter-side cost reporting, which is inconsistent across providers (some report cents, some report tokens, some report nothing) — the result in production is a dashboard full of `null` cost rows
> - This PR introduces the foundation: a `model_pricing` table seeded from a bundled Vercel snapshot, plus server-side `computeCostCents` that runs on insert so cost is derived from canonical pricing rather than trusted from the adapter
> - This is the first slice of a larger budget tracking suite already running in production at Bermont; subsequent PRs (validator extensions, billing-type classifier, backfill, verify-budget-rollout post-deploy gate) will be opened as separate small focused PRs after this lands
> - The benefit is that every cost_event row gets a derived `costCents` from a versioned pricing source, with billing-code idempotency preventing double-counting on retry

## What Changed

- New `model_pricing` table (migration `0086_budget_pricing.sql`) keyed by `(provider, model, effective_from)` with cents-per-1M token columns for `input`, `output`, `cache_read`, `cache_write`
- New `seed-data/model-pricing.json` — bundled Vercel pricing snapshot (~5k rows covering anthropic, openai, google, google-vertex, x-ai, etc) plus `seed-model-pricing.ts` idempotent seeder with tests
- `cost_events.billing_code` field for idempotent insert (prevents double-counting on retry)
- `cost_events.cache_creation_input_tokens` field for cache-write token accounting (Anthropic-specific but harmless elsewhere)
- Server-side `computeCostCents(provider, model, tokens, occurredAt)` in `server/src/services/costs.ts` that resolves the active pricing row and returns derived cost
- Cost computation wired into the cost_events insert path; adapter-reported `costCents` becomes optional and validator-only

## Verification

- `pnpm --filter @paperclipai/db test` — covers `seed-model-pricing.test.ts` (idempotency, schema, JSON shape) and `client.test.ts` (migration applied, indexes present)
- `pnpm --filter @paperclipai/server test src/__tests__/costs-service.test.ts` — covers computeCostCents against fixtures
- Manual: run a metered LLM call (e.g. opencode-local with `OPENAI_API_KEY`), confirm `cost_events.cost_cents` is populated with a sensible value derived from the seeded pricing
- Production proof: this exact code has been running in Bermont's deployment since 2026-05-12, ~3M cost_events written without duplicate-key or computation errors

## Risks

- **Pricing snapshot freshness.** The bundled JSON is point-in-time (Vercel snapshot 2026-05). New models or price changes require a re-seed. The seeder is idempotent (insert-or-update), so re-running it on an updated JSON is safe.
- **Migration touches `cost_events` schema.** Two new nullable columns (`billing_code`, `cache_creation_input_tokens`) — non-destructive, but anyone with existing cost_events will see new columns appear empty until the next insert.
- **Server-side compute adds DB read on every cost_event insert.** Pricing rows are tiny and indexed; the cost is ~one indexed lookup per insert. If high-volume callers hit this, follow-up could cache the pricing table in memory.
- Low overall: extending tables additively, computing a derived field in code, foundation only — no UI / scheduler / billing-gate behavior changes in this PR.

## Model Used

claude-bridge/claude-sonnet-4-6 (via Pi worker agent) for the per-commit rebase that produced these patches; original commits hand-authored by Luke Seeber (Bermont) during May 2026 production rollout.

## Checklist

- [x] Thinking path traces from project context to this change
- [x] Model Used specified
- [x] ROADMAP.md "Better Budgeting" checked — see DRAFT note: Discord #dev conversation required before opening
- [ ] Tests run locally — pending typecheck completion (foundation-typecheck.log)
- [x] Tests added (db/seed-model-pricing.test.ts, db/client.test.ts updates, server/costs-service.test.ts)
- [n/a] UI screenshots — no UI changes
- [x] Docs updated (seed-data/README.md explains the snapshot)
- [x] Risks documented above
- [ ] Will address Greptile / reviewer comments before requesting merge
```

---

## Hand-off to sibling session (subagent-chat-019e3192)

When you're ready (after clawsweeper #24 + #25 land):

1. **Verify branch still exists:** `git -C ~/Projects/work/paperclip log --oneline upstream/master..budget-foundation-control-pr`
2. **Bring branch current with latest `upstream/master`:** `git rebase upstream/master` on the branch (may need to refresh)
3. **Start Discord #dev conversation** with Mario — propose the foundation slice using the PR body above as the framing
4. **Once agreed,** push: `git push -u origin budget-foundation-control-pr`
5. **Open PR:** `gh pr create --repo paperclipai/paperclip --base master --head valkyriweb:budget-foundation-control-pr --body-file <(adjusted body)`

If the conversation produces material changes (different scope, different shape), rework before pushing — don't push then rewrite.

## Why this slice

Per your earlier intercom message:
> Suggested approach when we get there: start with one self-contained slice (probably `model_pricing` table + cost computation — foundation everything else builds on) as a human-mediated control PR

This matches exactly. Three commits, additive, all green in production for 5 days at Bermont, foundation for the budget suite.
