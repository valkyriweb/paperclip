import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const renderer = process.env.INVOICEGEN_INTEGRATION_BIN;

test("pinned Invoicegen release renders visible draft markings", { skip: !renderer }, async () => {
  const root = await mkdtemp(join(tmpdir(), "invoicegen-release-integration-"));
  const requestPath = join(root, "request.json");
  const configPath = join(root, "config.yaml");
  const approvalRecordPath = join(root, "approval.json");
  const options = {
    requestPath,
    configPath,
    templateContractPath: resolve("scripts/invoicegen-template-contract.json"),
    invoicegenBin: resolve(renderer),
    registerPath: join(root, "register.json"),
    outputDir: join(root, "out"),
    approvalId: "release-integration-approval",
    companyId: "bermont-company",
  };
  await mkdir(options.outputDir);
  await writeFile(configPath, "sender:\n  name: Bermont Digital\ndefaults:\n  currency: ZAR\n  number_prefix: INVBD\n  tax_rate: 0\n");
  const items = Array.from({ length: 80 }, (_, index) => ({ description: `Integration line ${index + 1}`, quantity: 1, rate: 1 }));
  await writeFile(requestPath, JSON.stringify({
    schemaVersion: 1,
    state: "draft",
    idempotencyKey: "release-integration-invbd348",
    invoice: {
      number: 348,
      number_prefix: "INVBD",
      draft: true,
      date: "2026-08-25",
      client: { bill_to: "Integration Client", ship_to: "", default_rate: 1 },
      po_number: null,
      notes: "Release integration draft",
      tax_rate: 0,
      tax_note: "",
      items,
    },
  }));
  const server = createServer(async (_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(await readFile(approvalRecordPath, "utf8"));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  server.unref();
  process.env.PAPERCLIP_API_KEY = "integration-api-key";
  const workflowPath = join(root, "invoicegen-approved-draft.mjs");
  const source = (await readFile(resolve("scripts/invoicegen-approved-draft.mjs"), "utf8"))
    .replace("http://127.0.0.1:3100", `http://127.0.0.1:${server.address().port}`);
  await writeFile(workflowPath, source);
  const { prepareApproval, runApprovedDraft } = await import(workflowPath);
  const payload = await prepareApproval(options);
  Object.assign(payload.numberReservation, {
    reservedBy: "Integration Operator",
    reservedAt: "2026-08-25T14:00:00Z",
    evidenceReference: "release integration fixture",
    iqHandoff: "human-verified",
  });
  await writeFile(approvalRecordPath, JSON.stringify({
    id: options.approvalId,
    type: "request_board_approval",
    status: "approved",
    companyId: options.companyId,
    decidedByUserId: "integration-user",
    decidedAt: "2026-08-25T14:01:00Z",
    payload,
  }));
  const result = await runApprovedDraft(options);
  const extraction = spawnSync(process.env.PDFTOTEXT_BIN ?? "pdftotext", [result.artifactPath, "-"], { encoding: "utf8" });
  assert.equal(extraction.status, 0, extraction.stderr);
  assert.match(extraction.stdout, /Draft Invoice/);
  assert.match(extraction.stdout, /No\. INVBD348/);
  assert.match(extraction.stdout, /DRAFT DATE/);
  const pages = extraction.stdout.split("\f").filter(Boolean);
  assert.ok(pages.length > 1, "fixture must produce a multi-page PDF");
  for (const page of pages) assert.match(page, /DRAFT — NOT ISSUED/);
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.hashes.rendererSha256, createHash("sha256").update(await readFile(renderer)).digest("hex"));
});
