---
name: paperclip-documents
description: >
  Use Paperclip's per-issue documents API to store and edit durable artifacts
  on an issue — plans, designs, schemas, drafts, runbooks — that need
  versioning, locking, and revision history. Distinct from issue comments
  (which are appended events) and issue body (which is the issue's summary).
  Lock-then-edit pattern with base-revision conflict detection.
---

# Paperclip documents

**Trigger:** the work product is a durable artifact that will be revised multiple times — a plan, a design doc, a draft JD, a runbook, a schema. Use this instead of long comments or repeated issue-body rewrites.

## When to use which surface

| Surface | Use for | Don't use for |
|---|---|---|
| **Issue body** | The one-paragraph summary + acceptance criteria. Stable once written. | Iterating artifacts. |
| **Comments** | Events: status updates, decisions made, evidence captured, replies. Appended, not edited. | Durable artifacts (loses revision history; pollutes the feed). |
| **Documents** | Plans, designs, drafts, runbooks. Anything you'll revise. Has keys, locks, revisions. | One-off status updates (use a comment). |

A document has a `key` (slug, e.g. `plan`, `design`, `jd-draft`), `format` (`markdown` mostly), and `body`. Revisions are tracked; you edit against a `baseRevisionId` to detect concurrent edits.

## API surface

All endpoints under `$PAPERCLIP_API_URL`, `Authorization: Bearer $PAPERCLIP_API_KEY`, `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` on every mutation.

| Verb | Path | Purpose |
|---|---|---|
| `GET` | `/api/issues/:id/documents` | List documents on an issue. |
| `GET` | `/api/issues/:id/documents/:key` | Get a specific document by key (includes latest revision). |
| `PUT` | `/api/issues/:id/documents/:key` | Upsert (create or update) a document. Body: `{ title, format, body, changeSummary?, baseRevisionId? }`. |
| `POST` | `/api/issues/:id/documents/:key/lock` | Take an exclusive lock for editing. |
| `POST` | `/api/issues/:id/documents/:key/unlock` | Release the lock. |
| `GET` | `/api/issues/:id/documents/:key/revisions` | Revision history. |

## Lock-then-edit pattern

For any document edit, especially when multiple agents may touch the same key:

```bash
# 1. Fetch current state — capture revisionId
DOC=$(curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/issues/$ISSUE/documents/$KEY")
BASE_REV=$(echo "$DOC" | jq -r '.latestRevision.id // "null"')

# 2. Take the lock
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  "$PAPERCLIP_API_URL/api/issues/$ISSUE/documents/$KEY/lock"

# 3. Edit (compute new body from old, then upsert)
NEW_BODY=$(...)  # your edit
jq -n --arg title "Plan" --arg format "markdown" --arg body "$NEW_BODY" --arg base "$BASE_REV" --arg summary "Added <thing>" \
  '{title:$title, format:$format, body:$body, baseRevisionId:$base, changeSummary:$summary}' \
  | curl -s -X PUT \
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
      -H "Content-Type: application/json" \
      "$PAPERCLIP_API_URL/api/issues/$ISSUE/documents/$KEY" -d @-

# 4. Release the lock
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  "$PAPERCLIP_API_URL/api/issues/$ISSUE/documents/$KEY/unlock"
```

If a concurrent agent updated the doc between your fetch and your upsert, the `baseRevisionId` mismatch produces a conflict. Agent-actor PUTs default to `lockedDocumentStrategy=create_new_document` (your edit creates a new document at a related key rather than clobbering). User-actor PUTs default to `conflict` (fail loud). Either way: don't blind-overwrite.

## Conventional document keys

Stable slugs the platform expects:

- `plan` — implementation plan for the issue.
- `design` — design/architecture spec.
- `acceptance` — explicit acceptance criteria (when richer than a checklist in the body).
- `transcript` — captured agent transcript or run log excerpt.
- `meta` — issue metadata extension (rare).

Free-form keys are also valid (slug-lowercased) for issue-specific artifacts — `jd-draft`, `mara-identity`, `proposal-v2`, etc.

## When NOT to use documents

- **Throwaway scratch work.** Use your session notes, not a Paperclip document.
- **Short replies / status updates.** Comment.
- **Status changes.** PATCH the issue.
- **Cross-issue artifacts.** Documents are scoped per-issue. For cross-issue runbooks, use a skill, a wiki page, or a dedicated issue with a stable identifier.

## Don't

- Don't put secrets, credentials, or PII in a document. Same rules as issue bodies.
- Don't bypass the lock when you suspect concurrent edits; the conflict-detection is the point.
- Don't store binary content; documents are text. For attachments, use the issue attachments API.
- Don't store the same artifact in both a document and the issue body — pick one.

## See also

- `paperclip` — the canonical Paperclip API skill (heartbeat procedure, auth, comments, issues).
- `how-we-work` — issue is the record; comments are evidence.
- `how-we-communicate` — voice when writing documents (same as comments).
