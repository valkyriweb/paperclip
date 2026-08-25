# Invoicegen synthetic draft workflow

This milestone proves an outside-IQ Invoicegen path with synthetic data only. It cannot approve, issue, or send an invoice. It does not access IQ Retail or the shared Windows server.

## Safety contract

`scripts/invoicegen-draft-workflow.mjs` accepts only requests with all of these properties:

- `mode` is `synthetic`.
- `state` is `draft`.
- The number is in the isolated `990000`–`999999` synthetic range.
- The sender, client, notes, tax fields, and line item match the exact checked-in synthetic fixture.
- The config hash matches the exact checked-in ZAR synthetic config.
- The renderer binary hash matches an approved binary from the pinned release.
- The request has no email address or send, approval, or issuance field at any nesting depth.

The tool invokes only `invoicegen generate`. It has no approve, issue, send, email, IQ, or server integration. Any `approved`, `issued`, or `sent` state fails before the renderer starts.

## Dry run

Use an empty operator-controlled directory. Do not put production client data in the request.

```sh
work_dir="$(mktemp -d)"
node scripts/invoicegen-draft-workflow.mjs \
  --request-path scripts/invoicegen-fixtures/synthetic-request.json \
  --register-path "$work_dir/number-register.json" \
  --output-dir "$work_dir/drafts" \
  --config-path scripts/invoicegen-fixtures/synthetic-config.yaml \
  --template-contract-path scripts/invoicegen-fixtures/template-contract.json \
  --invoicegen-bin /usr/local/bin/invoicegen
```

The output directory contains the canonical input, draft PDF, and `audit-manifest.json`. The workflow stages private copies of the config and renderer, hashes the copies it uses, renders to a temporary path, requires a PDF header, and only then promotes the artifact. The manifest records exact SHA-256 hashes for the request, config, embedded template source, template contract, renderer binary, canonical input, and artifact. The checked-in template contract pins fork tag `v0.1.2-bermont.1`, commit `1929e7ba9536c8801ddcd039d07ebd446b5b8b09`, and its embedded template source hash.

A repeated command with identical inputs returns `idempotent: true` and does not render again. The coordinated JSON register binds each synthetic number and idempotency key under an atomic directory lock. Each lock records its owner process. A later run reclaims the lock only when that process is demonstrably absent. Reusing either identity with different content fails closed. A renderer failure leaves the number reserved so an operator can retry the same request without creating a duplicate.

## Human handoff for any future real invoice

This milestone does **not** support real invoices. Before extending it, a human must complete and record all of these steps in the Paperclip issue:

1. Review the real client, recipient, line items, amount, VAT treatment, and invoice date.
2. Inspect IQ Retail directly and reserve the real `INVBD` number in the single coordinated production register. No Paperclip agent performs this step.
3. Record the human approver, approval time, reservation evidence, and exact approved input hashes.
4. Approve a separate implementation that preserves distinct `draft`, `approved`, `issued`, and `sent` states. State transitions must be explicit and audited.
5. Keep issuance and sending as separate human actions. A draft approval must never imply issue or send.

Do not copy the synthetic register into a production number register. Do not treat a synthetic PDF as an invoice.

## Verification

```sh
node --test scripts/invoicegen-draft-workflow.test.mjs
```

The tests use a fake local renderer. They do not contain client data. They do not issue or send an invoice.

## Rollback

1. Stop invoking the wrapper. It has no background service.
2. Preserve `audit-manifest.json` and `number-register.json` as audit evidence.
3. Remove the generated synthetic draft directory if it is no longer needed.
4. Revert the wrapper, fixtures, test, and this runbook from source control.

Rollback requires no IQ change, credential change, service restart, image change, deployment, or client communication.
