# Invoicegen approved draft workflow

This workflow generates usable Bermont invoice PDF drafts with real approved invoice details. It does not access IQ Retail, issue an invoice, or send email.

## Required human steps

Before rendering, a human must:

1. Review the client, amount, VAT, date, line items, and recipient details.
2. Check IQ Retail directly and reserve the `INVBD` number in the coordinated register.
3. Record the reservation evidence in the approval packet.
4. Approve PDF draft generation only.

A Paperclip agent must not perform the IQ check or number reservation.

## Request format

Create a JSON request with `state: "draft"`, a stable idempotency key, and normal Invoicegen invoice data. Bermont invoices require `number_prefix: "INVBD"`.

```json
{
  "schemaVersion": 1,
  "state": "draft",
  "idempotencyKey": "invbd348-client-cycle-2026-08",
  "invoice": {
    "number": 348,
    "number_prefix": "INVBD",
    "date": "2026-08-25",
    "client": {
      "bill_to": "Approved Client\nApproved address",
      "ship_to": "",
      "default_rate": 100
    },
    "po_number": null,
    "notes": "Approved invoice notes",
    "tax_rate": 15,
    "tax_note": "VAT 15%",
    "items": [
      { "description": "Approved service", "quantity": 1, "rate": 100 }
    ]
  }
}
```

## Prepare the approval packet

```sh
node scripts/invoicegen-approved-draft.mjs prepare-approval \
  --request-path request.json \
  --config-path /paperclip/.config/invoicegen/config.yaml \
  --template-contract-path scripts/invoicegen-template-contract.json \
  --invoicegen-bin /usr/local/bin/invoicegen \
  > approval-payload.json
```

This packet binds the exact request, sender config, renderer, and template contract hashes. A human fills in `reservedBy`, `reservedAt`, `evidenceReference`, and `iqHandoff: "human-verified"`. The operator then creates a Paperclip approval:

```sh
paperclipai approval create --profile bermont \
  -C 5d217ebe-1844-4d6e-bfef-06ee0c541750 \
  --type request_board_approval \
  --payload "$(jq -c . approval-payload.json)" \
  --issue-ids <paperclip-issue-uuid>
```

The board must approve that Paperclip record. An editable local JSON file is not approval.

Changing the request, config, renderer, or template after board approval invalidates the packet.

## Render the approved draft

```sh
node scripts/invoicegen-approved-draft.mjs render \
  --request-path request.json \
  --approval-id <approved-paperclip-approval-id> \
  --paperclip-profile bermont \
  --company-id 5d217ebe-1844-4d6e-bfef-06ee0c541750 \
  --register-path /paperclip/shared/invoicegen/number-register.json \
  --output-dir /paperclip/shared/invoicegen/drafts \
  --config-path /paperclip/.config/invoicegen/config.yaml \
  --template-contract-path scripts/invoicegen-template-contract.json \
  --invoicegen-bin /usr/local/bin/invoicegen
```

The output is named `INVBD<number>-DRAFT.pdf`. The audit manifest records approval identity and exact hashes. Repeating the same approved request is idempotent. Reusing a number or idempotency key with different content fails closed.

## Lock diagnosis

The number register and execution locks end in `.lock`. They contain only PID, hostname, and an ownership token. If the process crashes, the lock remains deliberately fail-closed.

Before manual cleanup:

1. Confirm the recorded pod or hostname no longer exists.
2. Confirm the recorded PID is not running on that host.
3. Confirm no approved-draft process is active in any Paperclip pod.
4. Preserve the register, request, approval, PDF, and manifest.
5. Remove only the stale `.lock` file.
6. Retry with the same request and idempotency key.

A renderer failure leaves the approved number reserved and removes temporary PDF output.

## Verification

```sh
pnpm test:invoicegen-approved-draft
```

Tests use approved example client data and a fake local renderer. They do not access IQ, issue invoices, or send messages.

## Rollback

Stop invoking the CLI and preserve the number register and audit manifests. Reverting the script requires no IQ change, credential change, email, deployment restart, or client communication.
