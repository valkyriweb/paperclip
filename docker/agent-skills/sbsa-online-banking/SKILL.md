---
name: sbsa-online-banking
description: Use for Standard Bank South Africa / SBSA Online Banking browser automation in Paperclip, especially Smilerite BIZLAUNCH statement/CSV pulls, QR reauth, pinned pinchtab flows, and Beancount handoff. Triggers: Standard Bank, SBSA, BizLaunch, bank statement download, e-statements, transactions CSV, Smilerite bank import.
---

# SBSA Online Banking

Use this for **Standard Bank South Africa Online Banking** automation from the Paperclip runtime. Current proven path is Smilerite’s Business Banking / BIZLAUNCH account ending `5048` via the Paperclip pinchtab sidecar profile `stdbank-luke`.

## Hard rules

- ZAR only.
- Never persist passwords, OTPs, QR payloads, cookies, session tokens, or full card/account credentials in comments, commits, logs, or files.
- Use `concealed: true` for any browser fill that could contain a credential.
- Start QR reauth only when Luke is ready to scan; QR windows are tight.
- Do not manually transcribe/categorize PDF statements into Beancount. PDF is audit artifact; CSV with balances is importer source.
- Financial uncertainty becomes a follow-up issue; do not guess categories for suspicious or large items.

## Current Smilerite facts

- Paperclip company: `668a67d2-d03e-458c-a0cc-f7c1a8962c9c` (`--profile smilerite`).
- Browser host: Paperclip pod pinchtab sidecar, profile `stdbank-luke`, port `9870`.
- SBSA context: `VERUS GROUP (PTY) LTD` = Smilerite.
- Account: BIZLAUNCH ending `5048`.
- Confirmed transactions URL pattern: `/sbsa/transact/history/details;selectedAccount=dd0dc882-b1a9-4cfc-afc1-55f020c3f19b/transactions`.
- Confirmed download flow: transactions page → `DOWNLOAD` dropdown → `CSV` → modal → download `Transactions_with_balances.csv` blob.
- Confirmed CSV shape: `DATE,DESCRIPTION,AMOUNT,BALANCE`, DD/MM/YYYY dates, ZAR-prefixed balances.

## Reauth workflow

When a session is stale, perform a deterministic QR autopost from inside the Paperclip runtime:

1. Open/drive SBSA login with pinned selectors.
2. Detect QR in the DOM.
3. Upload QR as a Paperclip attachment immediately.
4. Comment on the issue with scan instructions.
5. Wait for Luke scan/approval and verify dashboard/context URL.

Use the runtime's available Paperclip CLI and pinchtab/browser tools; do not rely on local Pi scripts. If two QR cycles fail, stop and escalate. Do not retry a third time.

## Statement/CSV pull workflow

1. Check for a warm `digital.standardbank.co.za` tab in `stdbank-luke`.
2. Navigate to `/sbsa/select-context`; if redirected to login, run reauth.
3. Select `VERUS GROUP (PTY) LTD`.
4. Navigate to the BIZLAUNCH transactions URL.
5. Keep session alive; click any idle modal `Continue` / `Stay` / `Keep session` button if it appears.
6. Download CSV with balances via the confirmed download flow.
7. File raw CSV in `valkyriweb/smilerite-books` under `raw/bank/sbsa/`.
8. Run the SBSA importer / split importer as appropriate for the date range.
9. Verify `bean-check` clean.
10. Post a Paperclip retro headed `## SBSA pull retro` with: date range, file path, commit, selector/workflow deltas, importer result, `bean-check` result, wall time, and follow-ups.

## First successful run evidence

- SMI-105: first SBSA pull parent issue.
- SMI-114: Naledi handoff/import cleanup.
- Commit: `valkyriweb/smilerite-books@78bc01ba`.
- Imported 166 SBSA bank transactions spanning 2025-11-20 to 2026-05-15.
- Closing balance verified: ZAR 17,596.06.
- `bean-check`: PASS.
