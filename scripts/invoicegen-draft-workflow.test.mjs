import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runDraftWorkflow } from "./invoicegen-draft-workflow.mjs";

const SHA256 = "3940eee903d905c614144ffcc7e5dc657a44ace84427743914ccf2c8684f171a";

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "invoicegen-draft-"));
  const bin = join(root, "fake-invoicegen.mjs");
  const config = join(root, "config.yaml");
  const templateContract = join(root, "template-contract.json");
  const request = join(root, "request.json");
  const outputDir = join(root, "out");
  const register = join(root, "number-register.json");
  const calls = join(root, "calls.log");

  await writeFile(
    bin,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const [, , command, input, outputFlag, output] = process.argv;
if (command !== "generate" || outputFlag !== "-o") process.exit(64);
appendFileSync(process.env.FAKE_CALLS, process.argv.slice(2).join(" ") + "\\n");
writeFileSync(output, Buffer.concat([Buffer.from("%PDF-synthetic\\n"), readFileSync(input)]));
`,
    { mode: 0o755 },
  );
  await writeFile(config, "sender:\n  name: SYNTHETIC TEST SENDER\ndefaults:\n  currency: ZAR\n");
  await writeFile(
    templateContract,
    JSON.stringify({
      rendererRepo: "valkyriweb/invoicegen",
      rendererVersion: "v0.1.2-bermont.1",
      rendererCommit: "1929e7ba9536c8801ddcd039d07ebd446b5b8b09",
      embeddedTemplatePath: "templates/invoice-minimal.typ",
      embeddedTemplateSha256: SHA256,
    }),
  );
  await writeFile(
    request,
    JSON.stringify({
      schemaVersion: 1,
      mode: "synthetic",
      state: "draft",
      idempotencyKey: "synthetic-2026-08-25-001",
      invoice: {
        number: 990001,
        date: "2026-08-25",
        sender: { name: "SYNTHETIC TEST SENDER", address: "TEST DATA ONLY" },
        client: {
          bill_to: "SYNTHETIC TEST CLIENT\nNOT A REAL RECIPIENT",
          ship_to: "SYNTHETIC TEST CLIENT\nNOT A REAL RECIPIENT",
          default_rate: 1,
        },
        notes: "DRAFT — SYNTHETIC TEST DATA — NOT FOR ISSUE OR SEND",
        tax_rate: 0,
        tax_note: "SYNTHETIC TEST ONLY",
        items: [{ description: "Synthetic service fixture", quantity: 1, rate: 1 }],
      },
      ...overrides,
    }),
  );
  await mkdir(outputDir);
  return { root, bin, config, templateContract, request, outputDir, register, calls };
}

async function run(f) {
  return runDraftWorkflow({
    requestPath: f.request,
    registerPath: f.register,
    outputDir: f.outputDir,
    configPath: f.config,
    templateContractPath: f.templateContract,
    invoicegenBin: f.bin,
    env: { ...process.env, FAKE_CALLS: f.calls },
  });
}

test("renders a deterministic synthetic draft with complete hash evidence", async () => {
  const f = await fixture();
  const first = await run(f);
  const second = await run(f);
  const calls = await readFile(f.calls, "utf8");
  const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"));

  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(calls.trim().split("\n").length, 1, "idempotent rerun must not render twice");
  assert.equal(manifest.workflowState, "draft");
  assert.equal(manifest.safety.mode, "synthetic");
  assert.equal(manifest.safety.iqAccess, "forbidden");
  assert.equal(manifest.safety.sendCapability, "absent");
  assert.equal(manifest.hashes.templateSha256, SHA256);
  for (const key of ["requestSha256", "configSha256", "templateContractSha256", "rendererSha256", "inputSha256", "artifactSha256"]) {
    assert.match(manifest.hashes[key], /^[a-f0-9]{64}$/, key);
  }
});

test("serializes concurrent retries so only one renderer runs", async () => {
  const f = await fixture();
  const results = await Promise.all([run(f), run(f)]);
  const calls = await readFile(f.calls, "utf8");

  assert.deepEqual(
    results.map((result) => result.idempotent).sort(),
    [false, true],
  );
  assert.equal(calls.trim().split("\n").length, 1);
});

test("rejects number and idempotency collisions", async () => {
  const f = await fixture();
  await run(f);

  const request = JSON.parse(await readFile(f.request, "utf8"));
  request.idempotencyKey = "synthetic-other-key";
  await writeFile(f.request, JSON.stringify(request));
  await assert.rejects(run(f), /invoice number 990001 is already reserved/);

  request.idempotencyKey = "synthetic-2026-08-25-001";
  request.invoice.number = 990002;
  await writeFile(f.request, JSON.stringify(request));
  await assert.rejects(run(f), /idempotency key .* is already bound/);
});

test("fails closed for non-draft states and non-synthetic data", async () => {
  for (const state of ["approved", "issued", "sent"]) {
    const f = await fixture({ state });
    await assert.rejects(run(f), /state must be draft/);
  }

  const f = await fixture({ mode: "real" });
  await assert.rejects(run(f), /mode must be synthetic/);
  await assert.rejects(readFile(f.calls, "utf8"), /ENOENT/, "renderer must not run");
});

test("rejects forbidden workflow fields at any nesting depth", async () => {
  const f = await fixture();
  const request = JSON.parse(await readFile(f.request, "utf8"));
  request.invoice.client.approvedAt = "2026-08-25T00:00:00Z";
  await writeFile(f.request, JSON.stringify(request));

  await assert.rejects(run(f), /field approvedAt is not allowed/);
  await assert.rejects(readFile(f.calls, "utf8"), /ENOENT/, "renderer must not run");
});

test("rejects template provenance that differs from the pinned release", async () => {
  const f = await fixture();
  const contract = JSON.parse(await readFile(f.templateContract, "utf8"));
  contract.embeddedTemplateSha256 = "0".repeat(64);
  await writeFile(f.templateContract, JSON.stringify(contract));

  await assert.rejects(run(f), /embedded template SHA-256 does not match/);
});

test("does not accept stale output left by a failed renderer", async () => {
  const f = await fixture();
  await writeFile(
    f.bin,
    `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
const output = process.argv[5];
const marker = process.env.FAILURE_MARKER;
if (!existsSync(marker)) {
  writeFileSync(marker, "failed");
  writeFileSync(output, "STALE PARTIAL");
  process.exit(1);
}
process.exit(0);
`,
    { mode: 0o755 },
  );
  const marker = join(f.root, "failure-marker");
  const options = { ...f, calls: f.calls };
  const runStale = () =>
    runDraftWorkflow({
      requestPath: options.request,
      registerPath: options.register,
      outputDir: options.outputDir,
      configPath: options.config,
      templateContractPath: options.templateContract,
      invoicegenBin: options.bin,
      env: { ...process.env, FAILURE_MARKER: marker },
    });

  await assert.rejects(runStale(), /renderer exited with status 1/);
  await assert.rejects(runStale(), /renderer did not create a non-empty PDF artifact/);
});

test("detects persisted input, config, and renderer changes", async () => {
  const f = await fixture();
  const result = await run(f);
  const executionDir = dirname(result.manifestPath);
  const inputPath = join(executionDir, "draft-990001.yaml");
  const originalInput = await readFile(inputPath);

  await writeFile(inputPath, "mutated");
  await assert.rejects(run(f), /input hash does not match/);

  await writeFile(inputPath, originalInput);
  const stagedConfigPath = join(executionDir, ".config", "invoicegen", "config.yaml");
  const originalConfig = await readFile(stagedConfigPath);
  await writeFile(stagedConfigPath, "mutated");
  await assert.rejects(run(f), /config hash does not match/);

  await writeFile(stagedConfigPath, originalConfig);
  const stagedRendererPath = join(executionDir, ".bin", "invoicegen");
  await writeFile(stagedRendererPath, "mutated");
  await assert.rejects(run(f), /renderer hash does not match/);
});

test("detects artifact changes instead of silently accepting a rerun", async () => {
  const f = await fixture();
  const result = await run(f);
  await writeFile(result.artifactPath, "mutated");
  await assert.rejects(run(f), /artifact hash does not match/);
});
