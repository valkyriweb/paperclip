import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { prepareApproval, runApprovedDraft } from "./invoicegen-approved-draft.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "approved-invoice-"));
  const requestPath = join(root, "request.json");
  const approvalRecordPath = join(root, "approval-record.json");
  const paperclipaiBin = join(root, "paperclipai.mjs");
  const configPath = join(root, "config.yaml");
  const templateContractPath = join(root, "template.json");
  const invoicegenBin = join(root, "invoicegen.mjs");
  const registerPath = join(root, "register.json");
  const outputDir = join(root, "out");
  await mkdir(outputDir);
  await writeFile(configPath, "sender:\n  name: Bermont Digital\ndefaults:\n  currency: ZAR\n  number_prefix: INVBD\n");
  await writeFile(
    invoicegenBin,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const input = process.argv[3];
const output = process.argv[5];
writeFileSync(output, Buffer.concat([Buffer.from("%PDF-approved-draft\\n"), readFileSync(input)]));
`,
    { mode: 0o755 },
  );
  const rendererSha256 = createHash("sha256").update(await readFile(invoicegenBin)).digest("hex");
  await writeFile(templateContractPath, JSON.stringify({ rendererRepo: "test", rendererVersion: "test", rendererCommit: "test", linuxAmd64ArchiveSha256: "a".repeat(64), linuxAmd64BinarySha256: rendererSha256, embeddedTemplatePath: "test", embeddedTemplateSha256: "b".repeat(64) }));
  await writeFile(
    requestPath,
    JSON.stringify({
      schemaVersion: 1,
      state: "draft",
      idempotencyKey: "invbd348-approved-draft",
      invoice: {
        number: 348,
        number_prefix: "INVBD",
        draft: true,
        date: "2026-08-25",
        client: { bill_to: "Example Approved Client\n1 Main Road", ship_to: "", default_rate: 100 },
        po_number: null,
        notes: "Approved draft only",
        tax_rate: 15,
        tax_note: "VAT 15%",
        items: [{ description: "Approved consulting work", quantity: 1, rate: 100 }],
      },
    }),
  );
  const options = { requestPath, configPath, templateContractPath, invoicegenBin, registerPath, outputDir, paperclipaiBin, approvalId: "approval-1", paperclipProfile: "bermont", companyId: "bermont-company", approvalRecordPath, testOnlyUseFixtureContract: true };
  const payload = await prepareApproval(options);
  Object.assign(payload.numberReservation, { reservedBy: "Luke", reservedAt: "2026-08-25T13:29:00Z", evidenceReference: "BER-400 human handoff", iqHandoff: "human-verified" });
  await writeFile(approvalRecordPath, JSON.stringify({ id: "approval-1", type: "request_board_approval", status: "approved", companyId: "bermont-company", decidedByUserId: "luke-user", decidedAt: "2026-08-25T13:30:00Z", payload }));
  await writeFile(paperclipaiBin, `#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(${JSON.stringify(approvalRecordPath)}, "utf8"));\n`, { mode: 0o755 });
  return options;
}

test("prepares an approval packet bound to request, config, renderer, and template", async () => {
  const f = await fixture();
  const approval = await prepareApproval(f);
  assert.equal(approval.kind, "invoicegen-draft-v1");
  assert.equal(approval.numberReservation.numberPrefix, "INVBD");
  for (const key of ["requestSha256", "configSha256", "rendererSha256", "templateContractSha256"]) {
    assert.match(approval[key], /^[a-f0-9]{64}$/);
  }
});

test("renders a real approved draft and retries idempotently", async () => {
  const f = await fixture();
  const first = await runApprovedDraft(f);
  const second = await runApprovedDraft(f);
  const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
  const input = await readFile(join(dirname(first.manifestPath), "INVBD348.yaml"), "utf8");
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(manifest.workflowState, "draft");
  assert.equal(manifest.invoiceIdentity, "INVBD348");
  assert.equal(manifest.safety.issueCapability, "absent");
  assert.equal(manifest.safety.sendCapability, "absent");
  assert.match(input, /Example Approved Client/);
});

test("fails closed without exact approval", async () => {
  const f = await fixture();
  const approval = JSON.parse(await readFile(f.approvalRecordPath, "utf8"));
  approval.payload.requestSha256 = "0".repeat(64);
  await writeFile(f.approvalRecordPath, JSON.stringify(approval));
  await assert.rejects(runApprovedDraft(f), /requestSha256 does not match/);
});

test("rejects issue or send states and fields", async () => {
  const f = await fixture();
  const request = JSON.parse(await readFile(f.requestPath, "utf8"));
  request.state = "sent";
  await writeFile(f.requestPath, JSON.stringify(request));
  await assert.rejects(runApprovedDraft(f), /state must be draft/);
});

test("requires approval from the configured company", async () => {
  const f = await fixture();
  const missingCompany = { ...f };
  delete missingCompany.companyId;
  await assert.rejects(runApprovedDraft(missingCompany), /company-id is required/);

  const wrongCompany = { ...f, companyId: "other-company" };
  await assert.rejects(runApprovedDraft(wrongCompany), /different company/);
});

test("rejects malformed number-register entries", async () => {
  const f = await fixture();
  await writeFile(
    f.registerPath,
    JSON.stringify({
      schemaVersion: 1,
      namespace: "invoicegen-approved-drafts-v1",
      reservations: [
        {
          numberPrefix: "INVBD",
          invoiceNumber: "348",
          idempotencyKey: "old-key",
          requestSha256: "0".repeat(64),
          approvalSha256: "1".repeat(64),
          state: "draft-reserved",
          reservationKind: "human-approved-iq-handoff",
        },
      ],
    }),
  );
  await assert.rejects(runApprovedDraft(f), /invalid reservation/);
});

test("fails closed when persisted artifact or manifest evidence is missing", async () => {
  const missingArtifact = await fixture();
  const first = await runApprovedDraft(missingArtifact);
  await unlink(first.artifactPath);
  await assert.rejects(runApprovedDraft(missingArtifact), /ENOENT/);

  const missingManifest = await fixture();
  const second = await runApprovedDraft(missingManifest);
  await unlink(second.manifestPath);
  await assert.rejects(runApprovedDraft(missingManifest), /artifact exists without its audit manifest/);
});

test("prevents duplicate invoice-number reservations", async () => {
  const first = await fixture();
  await runApprovedDraft(first);
  const request = JSON.parse(await readFile(first.requestPath, "utf8"));
  request.idempotencyKey = "invbd348-second-draft";
  await writeFile(first.requestPath, JSON.stringify(request));
  const payload = await prepareApproval(first);
  Object.assign(payload.numberReservation, { reservedBy: "Luke", reservedAt: "2026-08-25T13:39:00Z", evidenceReference: "BER-400 second", iqHandoff: "human-verified" });
  await writeFile(first.approvalRecordPath, JSON.stringify({ id: "approval-2", type: "request_board_approval", status: "approved", companyId: "bermont-company", decidedByUserId: "luke-user", decidedAt: "2026-08-25T13:40:00Z", payload }));
  await assert.rejects(runApprovedDraft(first), /INVBD348 is already reserved/);
});
