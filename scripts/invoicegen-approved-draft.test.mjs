import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "approved-invoice-"));
  const requestPath = join(root, "request.json");
  const approvalRecordPath = join(root, "approval-record.json");
  const approvalTracePath = join(root, "approval-trace.json");
  const mutateConfigSentinel = join(root, "mutate-config-during-approval");
  const configPath = join(root, "config.yaml");
  const renderTracePath = join(root, "renderer-invocations.log");
  const logoPath = join(root, "logo.svg");
  const templateContractPath = join(root, "template.json");
  const invoicegenBin = join(root, "invoicegen.mjs");
  const registerPath = join(root, "register.json");
  const outputDir = join(root, "out");
  await mkdir(outputDir);
  await writeFile(logoPath, "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>Bermont</text></svg>");
  await writeFile(configPath, `sender:\n  name: Bermont Digital\n  logo: ${logoPath}\ndefaults:\n  currency: ZAR\n  number_prefix: INVBD\n`);
  await writeFile(
    invoicegenBin,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const input = process.argv[3];
const output = process.argv[5];
appendFileSync(${JSON.stringify(renderTracePath)}, "render\\n");
writeFileSync(output, Buffer.concat([Buffer.from("%PDF-approved-draft\\n"), readFileSync(input)]));
`,
    { mode: 0o755 },
  );
  const rendererSha256 = createHash("sha256").update(await readFile(invoicegenBin)).digest("hex");
  await writeFile(templateContractPath, JSON.stringify({ rendererRepo: "valkyriweb/invoicegen", rendererVersion: "v0.1.2-bermont.3", rendererCommit: "af2fb920801fe016e54da384d145da5fd1e67c41", linuxAmd64ArchiveSha256: "dd18719fc46c0bf26c0934445187942c591ceda5d714a020dc0effbbaeda0bee", linuxAmd64BinarySha256: rendererSha256, embeddedTemplatePath: "templates/invoice-minimal.typ", embeddedTemplateSha256: "d028fab9b96c14881708175d00cd5d29647afd2cd7f106f0748b62c53785e159" }));
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
  const server = createServer(async (request, response) => {
    await writeFile(approvalTracePath, JSON.stringify({ url: request.url, authorization: request.headers.authorization ?? null }));
    if (await readFile(mutateConfigSentinel).catch(() => null)) await writeFile(configPath, "sender:\n  name: Attacker\ndefaults:\n  currency: USD\n  number_prefix: BAD\n");
    response.setHeader("content-type", "application/json");
    response.end(await readFile(approvalRecordPath, "utf8"));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  server.unref();
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  process.env.PAPERCLIP_API_KEY = "fixture-api-key";
  const workflowPath = join(root, "invoicegen-approved-draft.mjs");
  const source = (await readFile(resolve("scripts/invoicegen-approved-draft.mjs"), "utf8"))
    .replace("http://127.0.0.1:3100", apiBase)
    .replaceAll("/paperclip/.config/invoicegen/logo.svg", logoPath)
    .replace("907ce7ce767e82bbc9fd9d8a3dc1cf9cdf8c0d6dfe32e184aec9e161f0675ba5", rendererSha256);
  await writeFile(workflowPath, source);
  const workflow = await import(workflowPath);
  const options = { requestPath, configPath, templateContractPath, invoicegenBin, registerPath, outputDir, approvalId: "approval-1", companyId: "bermont-company", approvalRecordPath };
  const payload = await workflow.prepareApproval(options);
  Object.assign(payload.numberReservation, { reservedBy: "Luke", reservedAt: "2026-08-25T13:29:00Z", evidenceReference: "BER-400 human handoff", iqHandoff: "human-verified" });
  await writeFile(approvalRecordPath, JSON.stringify({ id: "approval-1", type: "request_board_approval", status: "approved", companyId: "bermont-company", decidedByUserId: "luke-user", decidedAt: "2026-08-25T13:30:00Z", payload }));
  return { ...options, approvalTracePath, logoPath, mutateConfigSentinel, renderTracePath, ...workflow };
}

test("CLI rejects approval executable and profile overrides", () => {
  for (const option of ["--paperclipai-bin", "--paperclip-profile"]) {
    const result = spawnSync(process.execPath, [resolve("scripts/invoicegen-approved-draft.mjs"), "render", option, "untrusted"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported render option/);
  }
});

test("approval lookup ignores redirecting environment and uses the trusted API base", async () => {
  const f = await fixture();
  const previous = {
    url: process.env.PAPERCLIP_API_URL,
    context: process.env.PAPERCLIP_CONTEXT,
    key: process.env.PAPERCLIP_API_KEY,
  };
  Object.assign(process.env, {
    PAPERCLIP_API_URL: "http://attacker.invalid",
    PAPERCLIP_CONTEXT: "/tmp/attacker-context.json",
    PAPERCLIP_API_KEY: "untrusted-key-cannot-change-the-endpoint",
  });
  try {
    await f.runApprovedDraft(f);
  } finally {
    for (const [name, value] of [["PAPERCLIP_API_URL", previous.url], ["PAPERCLIP_CONTEXT", previous.context], ["PAPERCLIP_API_KEY", previous.key]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const trace = JSON.parse(await readFile(f.approvalTracePath, "utf8"));
  assert.equal(trace.url, "/api/approvals/approval-1");
  assert.equal(trace.authorization, "Bearer untrusted-key-cannot-change-the-endpoint");
});

test("renders only the config bytes captured before approval lookup", async () => {
  const f = await fixture();
  await writeFile(f.mutateConfigSentinel, "swap config");
  const result = await f.runApprovedDraft(f);
  const sourceConfig = await readFile(f.configPath, "utf8");
  const stagedConfig = await readFile(join(dirname(result.manifestPath), ".config", "invoicegen", "config.yaml"), "utf8");
  assert.match(sourceConfig, /Attacker/);
  assert.match(stagedConfig, /Bermont Digital/);
  assert.doesNotMatch(stagedConfig, /Attacker/);
});

test("prepares an approval packet bound to request, config, renderer, and template", async () => {
  const f = await fixture();
  const approval = await f.prepareApproval(f);
  assert.equal(approval.kind, "invoicegen-draft-v1");
  assert.equal(approval.numberReservation.numberPrefix, "INVBD");
  for (const key of ["requestSha256", "configSha256", "rendererSha256", "templateContractSha256"]) {
    assert.match(approval[key], /^[a-f0-9]{64}$/);
  }
});

test("renders a real approved draft and retries idempotently", async () => {
  const f = await fixture();
  const first = await f.runApprovedDraft(f);
  const second = await f.runApprovedDraft(f);
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

test("concurrent identical renders converge after one renderer invocation", async () => {
  const f = await fixture();
  const results = await Promise.all([f.runApprovedDraft(f), f.runApprovedDraft(f)]);
  assert.deepEqual(results.map((result) => result.idempotent).sort(), [false, true]);
  const invocations = (await readFile(f.renderTracePath, "utf8")).trim().split("\n");
  assert.equal(invocations.length, 1);
});

test("fails closed without exact approval", async () => {
  const f = await fixture();
  const approval = JSON.parse(await readFile(f.approvalRecordPath, "utf8"));
  approval.payload.requestSha256 = "0".repeat(64);
  await writeFile(f.approvalRecordPath, JSON.stringify(approval));
  await assert.rejects(f.runApprovedDraft(f), /requestSha256 does not match/);
});

test("rejects issue or send states and fields", async () => {
  const f = await fixture();
  const request = JSON.parse(await readFile(f.requestPath, "utf8"));
  request.state = "sent";
  await writeFile(f.requestPath, JSON.stringify(request));
  await assert.rejects(f.runApprovedDraft(f), /state must be draft/);
});

test("requires the reviewed Bermont ZAR and INVBD config identity", async () => {
  for (const [from, to, expected] of [
    ["Bermont Digital", "Other Sender", /sender must identify Bermont Digital/],
    ["currency: ZAR", "currency: USD", /currency must be ZAR/],
    ["number_prefix: INVBD", "number_prefix: OTHER", /number_prefix must be INVBD/],
  ]) {
    const f = await fixture();
    const config = await readFile(f.configPath, "utf8");
    await writeFile(f.configPath, config.replace(from, to));
    await assert.rejects(f.prepareApproval(f), expected);
  }
});

test("rejects logo changes after approval", async () => {
  const f = await fixture();
  await writeFile(f.logoPath, "<svg>changed after approval</svg>");
  await assert.rejects(f.runApprovedDraft(f), /logoSha256 does not match/);
});

test("requires approval from the configured company", async () => {
  const f = await fixture();
  const missingCompany = { ...f };
  delete missingCompany.companyId;
  await assert.rejects(f.runApprovedDraft(missingCompany), /company-id is required/);

  const wrongCompany = { ...f, companyId: "other-company" };
  await assert.rejects(f.runApprovedDraft(wrongCompany), /different company/);
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
  await assert.rejects(f.runApprovedDraft(f), /invalid reservation/);
});

test("fails closed when persisted artifact or manifest evidence is missing", async () => {
  const missingArtifact = await fixture();
  const first = await missingArtifact.runApprovedDraft(missingArtifact);
  await unlink(first.artifactPath);
  await assert.rejects(missingArtifact.runApprovedDraft(missingArtifact), /ENOENT/);

  const missingManifest = await fixture();
  const second = await missingManifest.runApprovedDraft(missingManifest);
  await unlink(second.manifestPath);
  await assert.rejects(missingManifest.runApprovedDraft(missingManifest), /artifact exists without its audit manifest/);
});

test("prevents duplicate invoice-number reservations", async () => {
  const first = await fixture();
  await first.runApprovedDraft(first);
  const request = JSON.parse(await readFile(first.requestPath, "utf8"));
  request.idempotencyKey = "invbd348-second-draft";
  await writeFile(first.requestPath, JSON.stringify(request));
  const payload = await first.prepareApproval(first);
  Object.assign(payload.numberReservation, { reservedBy: "Luke", reservedAt: "2026-08-25T13:39:00Z", evidenceReference: "BER-400 second", iqHandoff: "human-verified" });
  await writeFile(first.approvalRecordPath, JSON.stringify({ id: "approval-2", type: "request_board_approval", status: "approved", companyId: "bermont-company", decidedByUserId: "luke-user", decidedAt: "2026-08-25T13:40:00Z", payload }));
  await assert.rejects(first.runApprovedDraft(first), /INVBD348 is already reserved/);
});
