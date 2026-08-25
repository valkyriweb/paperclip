import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
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
  await writeFile(
    config,
    "sender:\n  name: SYNTHETIC TEST SENDER\n  address: |\n    TEST DATA ONLY\n    NOT A REAL BUSINESS\n\ndefaults:\n  currency: ZAR\n  date_format: '%Y-%m-%d'\n  tax_rate: 0\n  tax_note: SYNTHETIC TEST ONLY\n",
  );
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
        sender: { name: "SYNTHETIC TEST SENDER", address: "TEST DATA ONLY\nNOT A REAL BUSINESS" },
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
    testOnlyAllowUnpinnedRenderer: true,
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

test("rejects malformed and duplicate reservation entries", async () => {
  for (const reservations of [
    [
      {
        invoiceNumber: "990001",
        idempotencyKey: "synthetic-old-entry",
        requestSha256: "0".repeat(64),
        reservationKind: "synthetic-only",
        state: "reserved",
        humanHandoffRequiredForRealUse: true,
      },
    ],
    [
      {
        invoiceNumber: 990002,
        idempotencyKey: "synthetic-old-entry",
        requestSha256: "0".repeat(64),
        reservationKind: "synthetic-only",
        state: "reserved",
        humanHandoffRequiredForRealUse: true,
      },
      {
        invoiceNumber: 990002,
        idempotencyKey: "synthetic-other-entry",
        requestSha256: "1".repeat(64),
        reservationKind: "synthetic-only",
        state: "reserved",
        humanHandoffRequiredForRealUse: true,
      },
    ],
  ]) {
    const f = await fixture();
    await writeFile(
      f.register,
      JSON.stringify({
        schemaVersion: 1,
        namespace: "invoicegen-synthetic-v1",
        policy: {
          iqAccess: "human-only",
          realNumberReservation: "forbidden",
          handoff: "A human must reconcile any future real number in IQ before a separate approved workflow exists.",
        },
        reservations,
      }),
    );
    await assert.rejects(run(f), /number register reservation/);
  }
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

test("rejects real-looking text appended to synthetic fixture fields", async () => {
  const f = await fixture();
  const request = JSON.parse(await readFile(f.request, "utf8"));
  request.invoice.client.bill_to += "\nReal Customer Ltd";
  await writeFile(f.request, JSON.stringify(request));

  await assert.rejects(run(f), /bill_to must match the exact synthetic fixture/);
});

test("rejects forbidden workflow fields at any nesting depth", async () => {
  const f = await fixture();
  const request = JSON.parse(await readFile(f.request, "utf8"));
  request.invoice.client.approvedAt = "2026-08-25T00:00:00Z";
  await writeFile(f.request, JSON.stringify(request));

  await assert.rejects(run(f), /field approvedAt is not allowed/);
  await assert.rejects(readFile(f.calls, "utf8"), /ENOENT/, "renderer must not run");
});

test("rejects every unknown field instead of forwarding it to the renderer", async () => {
  for (const mutate of [
    (request) => (request.invoice.po_number = "REAL-PO"),
    (request) => (request.invoice.sender.logo = "/private/real-logo.svg"),
    (request) => (request.invoice.items[0].metadata = { customer: "real" }),
  ]) {
    const f = await fixture();
    const request = JSON.parse(await readFile(f.request, "utf8"));
    mutate(request);
    await writeFile(f.request, JSON.stringify(request));
    await assert.rejects(run(f), /unknown field/);
  }
});

test("reclaims a lock whose recorded owner process is dead", async () => {
  const f = await fixture();
  await mkdir(`${f.register}.lock`);
  await writeFile(
    join(`${f.register}.lock`, "owner.json"),
    JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, hostname: hostname() }),
  );

  const result = await run(f);
  assert.equal(result.idempotent, false);
});

test("serializes contenders that reclaim the same stale lock", async () => {
  const f = await fixture();
  await mkdir(`${f.register}.lock`);
  await writeFile(
    join(`${f.register}.lock`, "owner.json"),
    JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, hostname: hostname() }),
  );

  const results = await Promise.all([run(f), run(f), run(f), run(f)]);
  const calls = await readFile(f.calls, "utf8");
  assert.equal(results.filter((result) => !result.idempotent).length, 1);
  assert.equal(calls.trim().split("\n").length, 1);
});

test("does not reclaim a lock owned on another host", async () => {
  const f = await fixture();
  const lockPath = `${f.register}.lock`;
  await mkdir(lockPath);
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, hostname: "other-host", ownershipToken: "foreign" }),
  );

  const pending = run(f);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
  assert.equal(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).ownershipToken, "foreign");
  await rm(lockPath, { recursive: true });
  const result = await pending;
  assert.equal(result.idempotent, false);
});

test("rejects config that differs from the pinned synthetic fixture", async () => {
  const f = await fixture();
  await writeFile(f.config, "sender:\n  name: Real Business\ndefaults:\n  currency: USD\n");

  await assert.rejects(run(f), /config does not match the pinned synthetic fixture/);
});

test("rejects an unapproved renderer binary outside the test-only path", async () => {
  const f = await fixture();
  await assert.rejects(
    runDraftWorkflow({
      requestPath: f.request,
      registerPath: f.register,
      outputDir: f.outputDir,
      configPath: f.config,
      templateContractPath: f.templateContract,
      invoicegenBin: f.bin,
      env: { ...process.env, NODE_TEST_CONTEXT: "" },
    }),
    /renderer binary SHA-256 is not approved/,
  );
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
      testOnlyAllowUnpinnedRenderer: true,
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

test("rejects changed manifest identity, state, safety, or unknown metadata", async () => {
  for (const mutate of [
    (manifest) => (manifest.workflowState = "approved"),
    (manifest) => (manifest.idempotencyKey = "synthetic-other-key"),
    (manifest) => (manifest.safety.sendCapability = "present"),
    (manifest) => (manifest.unexpected = true),
  ]) {
    const f = await fixture();
    const result = await run(f);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    mutate(manifest);
    await writeFile(result.manifestPath, JSON.stringify(manifest));
    await assert.rejects(run(f), /existing audit manifest metadata does not match/);
  }
});

test("detects artifact changes instead of silently accepting a rerun", async () => {
  const f = await fixture();
  const result = await run(f);
  await writeFile(result.artifactPath, "mutated");
  await assert.rejects(run(f), /artifact hash does not match/);
});
