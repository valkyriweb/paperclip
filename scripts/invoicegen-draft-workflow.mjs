#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTER_SCHEMA_VERSION = 1;
const REQUEST_SCHEMA_VERSION = 1;
const SYNTHETIC_NUMBER_MIN = 990000;
const SYNTHETIC_NUMBER_MAX = 999999;
const PINNED_RENDERER_COMMIT = "1929e7ba9536c8801ddcd039d07ebd446b5b8b09";
const PINNED_TEMPLATE_SHA256 = "3940eee903d905c614144ffcc7e5dc657a44ace84427743914ccf2c8684f171a";
const PINNED_SYNTHETIC_CONFIG_SHA256 = "d4890cdda15d0741bc2a7d65cb1bf54b8a5e9975b7f70a05d4a9a942ecf99709";
const APPROVED_RENDERER_SHA256 = new Set([
  "eacc1bcc910408c4fd9e62cf435f22750f8e480a430ae05234f9127095d8e6af", // linux-amd64 production image
  "9f5341d0085ba7d0dca731aef9ef1742d619f411d2507491dabf859cce5b88c9", // macOS operator binary
]);
const LOCK_RETRIES = 1_400;
const LOCK_DELAY_MS = 25;

function fail(message) {
  throw new Error(`invoicegen draft workflow: ${message}`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path));
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    fail(`cannot read ${label} at ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function rejectForbiddenWorkflowFields(value) {
  const forbiddenKeys = new Set([
    "approval",
    "approve",
    "approved",
    "approvedat",
    "email",
    "issuance",
    "issue",
    "issued",
    "issuedat",
    "recipient",
    "send",
    "sent",
    "sentat",
  ]);
  if (Array.isArray(value)) {
    for (const entry of value) rejectForbiddenWorkflowFields(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (forbiddenKeys.has(normalizedKey)) fail(`field ${key} is not allowed in a synthetic draft`);
    rejectForbiddenWorkflowFields(entry);
  }
}

function assertExactKeys(value, allowedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`unknown field ${label}.${key} is not allowed in a synthetic draft`);
  }
}

function validateRequest(request) {
  rejectForbiddenWorkflowFields(request);
  assertExactKeys(request, ["schemaVersion", "mode", "state", "idempotencyKey", "invoice"], "request");
  if (request.schemaVersion !== REQUEST_SCHEMA_VERSION) fail("request schemaVersion must be 1");
  if (request.mode !== "synthetic") fail("mode must be synthetic; real client data requires a separate human-approved workflow");
  if (request.state !== "draft") fail("state must be draft; this tool cannot approve, issue, or send invoices");
  if (!/^synthetic-[a-z0-9-]{8,80}$/.test(request.idempotencyKey ?? "")) {
    fail("idempotencyKey must start with synthetic- and contain only lowercase letters, digits, and hyphens");
  }

  const invoice = request.invoice;
  assertExactKeys(invoice, ["number", "date", "sender", "client", "notes", "tax_rate", "tax_note", "items"], "invoice");
  assertExactKeys(invoice.sender, ["name", "address"], "invoice.sender");
  assertExactKeys(invoice.client, ["bill_to", "ship_to", "default_rate"], "invoice.client");
  if (!Number.isInteger(invoice.number) || invoice.number < SYNTHETIC_NUMBER_MIN || invoice.number > SYNTHETIC_NUMBER_MAX) {
    fail(`synthetic invoice number must be an integer from ${SYNTHETIC_NUMBER_MIN} to ${SYNTHETIC_NUMBER_MAX}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.date ?? "")) fail("invoice date must use YYYY-MM-DD");
  if (invoice.sender?.name !== "SYNTHETIC TEST SENDER" || invoice.sender?.address !== "TEST DATA ONLY\nNOT A REAL BUSINESS") {
    fail("sender must match the exact synthetic fixture");
  }
  if (invoice.client?.bill_to !== "SYNTHETIC TEST CLIENT\nNOT A REAL RECIPIENT") {
    fail("bill_to must match the exact synthetic fixture");
  }
  if (invoice.client?.ship_to !== "SYNTHETIC TEST CLIENT\nNOT A REAL RECIPIENT") {
    fail("ship_to must match the exact synthetic fixture");
  }
  if (invoice.client?.default_rate !== 1) fail("default_rate must match the exact synthetic fixture");
  if (invoice.notes !== "DRAFT — SYNTHETIC TEST DATA — NOT FOR ISSUE OR SEND") {
    fail("notes must match the exact synthetic fixture");
  }
  if (invoice.tax_rate !== 0 || invoice.tax_note !== "SYNTHETIC TEST ONLY") {
    fail("tax fields must match the exact synthetic fixture");
  }
  if (!Array.isArray(invoice.items) || invoice.items.length !== 1) {
    fail("line items must match the exact synthetic fixture");
  }
  assertExactKeys(invoice.items[0], ["description", "quantity", "rate"], "invoice.items[0]");
  if (
    invoice.items[0]?.description !== "Synthetic service fixture" ||
    invoice.items[0]?.quantity !== 1 ||
    invoice.items[0]?.rate !== 1
  ) {
    fail("line items must match the exact synthetic fixture");
  }

  const serialized = canonicalJson(request);
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(serialized)) fail("synthetic requests must not contain email addresses");
}

function validateTemplateContract(contract) {
  if (contract.rendererRepo !== "valkyriweb/invoicegen" || contract.rendererVersion !== "v0.1.2-bermont.1") {
    fail("template contract must identify the pinned Bermont Invoicegen release");
  }
  if (contract.rendererCommit !== PINNED_RENDERER_COMMIT) fail("renderer commit does not match the pinned release");
  if (contract.embeddedTemplatePath !== "templates/invoice-minimal.typ") fail("unexpected embedded template path");
  if (contract.embeddedTemplateSha256 !== PINNED_TEMPLATE_SHA256) {
    fail("embedded template SHA-256 does not match the pinned release");
  }
}

async function hasPdfHeader(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === header.length && header.toString("ascii") === "%PDF-";
  } finally {
    await handle.close();
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

async function readLockOwner(lockPath) {
  try {
    return JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

async function lockOwnerIsDead(lockPath) {
  const owner = await readLockOwner(lockPath);
  return Boolean(owner?.schemaVersion === 1 && owner.hostname === hostname() && !processIsAlive(owner.pid));
}

async function acquireOwnedDirectory(lockPath) {
  const ownershipToken = randomUUID();
  const candidatePath = `${lockPath}.candidate-${ownershipToken}`;
  await mkdir(candidatePath);
  await writeFile(
    join(candidatePath, "owner.json"),
    canonicalJson({ schemaVersion: 1, pid: process.pid, hostname: hostname(), ownershipToken }),
    { mode: 0o600 },
  );
  try {
    await rename(candidatePath, lockPath);
    return ownershipToken;
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true });
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY") return null;
    throw error;
  }
}

async function releaseOwnedLock(lockPath, ownershipToken) {
  const owner = await readLockOwner(lockPath);
  if (owner?.ownershipToken === ownershipToken) {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function reclaimDeadOwnerLock(lockPath) {
  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimToken = await acquireOwnedDirectory(reclaimPath);
  if (!reclaimToken) return false;

  try {
    if (!(await lockOwnerIsDead(lockPath))) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } finally {
    await releaseOwnedLock(reclaimPath, reclaimToken);
  }
}

async function withLock(registerPath, action) {
  const lockPath = `${registerPath}.lock`;
  await mkdir(dirname(registerPath), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    const ownershipToken = await acquireOwnedDirectory(lockPath);
    if (!ownershipToken) {
      if (await reclaimDeadOwnerLock(lockPath)) continue;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_DELAY_MS));
      continue;
    }

    try {
      return await action();
    } finally {
      await releaseOwnedLock(lockPath, ownershipToken);
    }
  }
  fail(`timed out acquiring coordinated number-register lock ${lockPath}`);
}

async function atomicWriteJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, canonicalJson(value), { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function validateRegisterReservations(reservations) {
  const invoiceNumbers = new Set();
  const idempotencyKeys = new Set();
  for (const reservation of reservations) {
    assertExactKeys(
      reservation,
      [
        "invoiceNumber",
        "idempotencyKey",
        "requestSha256",
        "reservationKind",
        "state",
        "humanHandoffRequiredForRealUse",
      ],
      "number register reservation",
    );
    if (
      !Number.isInteger(reservation.invoiceNumber) ||
      reservation.invoiceNumber < SYNTHETIC_NUMBER_MIN ||
      reservation.invoiceNumber > SYNTHETIC_NUMBER_MAX ||
      !/^synthetic-[a-z0-9-]{8,80}$/.test(reservation.idempotencyKey ?? "") ||
      !/^[a-f0-9]{64}$/.test(reservation.requestSha256 ?? "") ||
      reservation.reservationKind !== "synthetic-only" ||
      reservation.state !== "reserved" ||
      reservation.humanHandoffRequiredForRealUse !== true
    ) {
      fail("number register reservation has invalid field types or values");
    }
    if (invoiceNumbers.has(reservation.invoiceNumber)) fail("number register reservation invoice numbers must be unique");
    if (idempotencyKeys.has(reservation.idempotencyKey)) fail("number register reservation idempotency keys must be unique");
    invoiceNumbers.add(reservation.invoiceNumber);
    idempotencyKeys.add(reservation.idempotencyKey);
  }
}

async function reserveSyntheticNumber(registerPath, request, requestSha256) {
  return withLock(registerPath, async () => {
    let register;
    try {
      register = await readJson(registerPath, "number register");
    } catch (error) {
      if (!error.message.includes("cannot read number register") || !error.message.includes("ENOENT")) throw error;
      register = {
        schemaVersion: REGISTER_SCHEMA_VERSION,
        namespace: "invoicegen-synthetic-v1",
        policy: {
          iqAccess: "human-only",
          realNumberReservation: "forbidden",
          handoff: "A human must reconcile any future real number in IQ before a separate approved workflow exists.",
        },
        reservations: [],
      };
    }
    if (register.schemaVersion !== REGISTER_SCHEMA_VERSION || register.namespace !== "invoicegen-synthetic-v1" || !Array.isArray(register.reservations)) {
      fail("number register has an unsupported schema or namespace");
    }
    validateRegisterReservations(register.reservations);

    const numberMatch = register.reservations.find((entry) => entry.invoiceNumber === request.invoice.number);
    const keyMatch = register.reservations.find((entry) => entry.idempotencyKey === request.idempotencyKey);
    if (numberMatch && numberMatch.idempotencyKey !== request.idempotencyKey) {
      fail(`invoice number ${request.invoice.number} is already reserved by another idempotency key`);
    }
    if (keyMatch && keyMatch.invoiceNumber !== request.invoice.number) {
      fail(`idempotency key ${request.idempotencyKey} is already bound to invoice number ${keyMatch.invoiceNumber}`);
    }
    const existing = numberMatch ?? keyMatch;
    if (existing) {
      if (existing.requestSha256 !== requestSha256) fail(`idempotency key ${request.idempotencyKey} is already bound to different request content`);
      return existing;
    }

    const reservation = {
      invoiceNumber: request.invoice.number,
      idempotencyKey: request.idempotencyKey,
      requestSha256,
      reservationKind: "synthetic-only",
      state: "reserved",
      humanHandoffRequiredForRealUse: true,
    };
    register.reservations.push(reservation);
    register.reservations.sort((a, b) => a.invoiceNumber - b.invoiceNumber);
    await atomicWriteJson(registerPath, register);
    return reservation;
  });
}

function buildAuditManifest({ request, templateContract, inputPath, artifactPath, renderedArtifactPath, hashes }) {
  return {
    schemaVersion: 1,
    workflowState: "draft",
    idempotencyKey: request.idempotencyKey,
    invoiceNumber: request.invoice.number,
    renderer: {
      repository: templateContract.rendererRepo,
      version: templateContract.rendererVersion,
      commit: templateContract.rendererCommit,
      invocation: ["generate", basename(inputPath), "-o", basename(renderedArtifactPath)],
    },
    safety: {
      mode: "synthetic",
      iqAccess: "forbidden",
      realNumberReservation: "forbidden",
      approvalCapability: "absent",
      issuanceCapability: "absent",
      sendCapability: "absent",
      humanHandoffRequiredForRealUse: true,
    },
    hashes,
    files: { input: basename(inputPath), artifact: basename(artifactPath) },
  };
}

export async function runDraftWorkflow(options) {
  const requestPath = resolve(options.requestPath);
  const registerPath = resolve(options.registerPath);
  const outputDir = resolve(options.outputDir);
  const configPath = resolve(options.configPath);
  const templateContractPath = resolve(options.templateContractPath);
  const invoicegenBin = resolve(options.invoicegenBin);
  const env = options.env ?? process.env;

  const request = await readJson(requestPath, "request");
  validateRequest(request);
  const templateContract = await readJson(templateContractPath, "template contract");
  validateTemplateContract(templateContract);

  const requestSha256 = sha256Bytes(canonicalJson(request));
  await reserveSyntheticNumber(registerPath, request, requestSha256);

  const executionId = `${request.invoice.number}-${sha256Bytes(request.idempotencyKey).slice(0, 12)}`;
  const executionDir = join(outputDir, executionId);
  const inputPath = join(executionDir, `draft-${request.invoice.number}.yaml`);
  const artifactPath = join(executionDir, `draft-${request.invoice.number}.pdf`);
  const renderedArtifactPath = `${artifactPath}.rendering`;
  const manifestPath = join(executionDir, "audit-manifest.json");
  const configHome = join(executionDir, ".config", "invoicegen");
  const stagedConfigPath = join(configHome, "config.yaml");
  const rendererDir = join(executionDir, ".bin");
  const stagedRendererPath = join(rendererDir, "invoicegen");
  const invoiceInput = canonicalJson(request.invoice);

  return withLock(manifestPath, async () => {
    const hashes = {
      requestSha256,
      configSha256: await sha256File(configPath),
      templateSha256: templateContract.embeddedTemplateSha256,
      templateContractSha256: sha256Bytes(canonicalJson(templateContract)),
      rendererSha256: await sha256File(invoicegenBin),
      inputSha256: sha256Bytes(invoiceInput),
    };
    if (hashes.configSha256 !== PINNED_SYNTHETIC_CONFIG_SHA256) {
      fail("config does not match the pinned synthetic fixture");
    }
    const testRendererAllowed = options.testOnlyAllowUnpinnedRenderer === true && Boolean(env.NODE_TEST_CONTEXT);
    if (!APPROVED_RENDERER_SHA256.has(hashes.rendererSha256) && !testRendererAllowed) {
      fail("renderer binary SHA-256 is not approved for the pinned Invoicegen release");
    }

    try {
      const manifest = await readJson(manifestPath, "existing audit manifest");
      for (const [key, value] of Object.entries(hashes)) {
        if (manifest.hashes?.[key] !== value) fail(`existing manifest ${key} does not match this execution`);
      }
      const persistedInputSha256 = await sha256File(inputPath);
      if (manifest.hashes?.inputSha256 !== persistedInputSha256) {
        fail("existing input hash does not match its audit manifest");
      }
      const persistedConfigSha256 = await sha256File(stagedConfigPath);
      if (manifest.hashes?.configSha256 !== persistedConfigSha256) {
        fail("existing config hash does not match its audit manifest");
      }
      const persistedRendererSha256 = await sha256File(stagedRendererPath);
      if (manifest.hashes?.rendererSha256 !== persistedRendererSha256) {
        fail("existing renderer hash does not match its audit manifest");
      }
      const artifactSha256 = await sha256File(artifactPath);
      if (manifest.hashes?.artifactSha256 !== artifactSha256) {
        fail("existing artifact hash does not match its audit manifest");
      }
      hashes.artifactSha256 = artifactSha256;
      const expectedManifest = buildAuditManifest({
        request,
        templateContract,
        inputPath,
        artifactPath,
        renderedArtifactPath,
        hashes,
      });
      if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
        fail("existing audit manifest metadata does not match this execution");
      }
      return { artifactPath, manifestPath, idempotent: true };
    } catch (error) {
      if (!error.message.includes("cannot read existing audit manifest") || !error.message.includes("ENOENT")) throw error;
    }

    await mkdir(configHome, { recursive: true });
    await mkdir(rendererDir, { recursive: true });
    await copyFile(configPath, stagedConfigPath);
    await chmod(stagedConfigPath, 0o600);
    await copyFile(invoicegenBin, stagedRendererPath);
    await chmod(stagedRendererPath, 0o700);
    await writeFile(inputPath, invoiceInput, { mode: 0o600 });

    if ((await sha256File(stagedConfigPath)) !== hashes.configSha256) {
      fail("config changed while it was staged; draft remains reserved and can be retried");
    }
    if ((await sha256File(stagedRendererPath)) !== hashes.rendererSha256) {
      fail("renderer changed while it was staged; draft remains reserved and can be retried");
    }

    await rm(renderedArtifactPath, { force: true });
    const result = spawnSync(stagedRendererPath, ["generate", inputPath, "-o", renderedArtifactPath], {
      cwd: executionDir,
      env: { ...env, XDG_CONFIG_HOME: join(executionDir, ".config") },
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error) {
      await rm(renderedArtifactPath, { force: true });
      fail(`renderer did not execute: ${result.error.message}`);
    }
    if (result.status !== 0) {
      await rm(renderedArtifactPath, { force: true });
      fail(`renderer exited with status ${result.status}; draft remains reserved and can be retried`);
    }
    const artifactStat = await stat(renderedArtifactPath).catch(() => null);
    if (!artifactStat?.isFile() || artifactStat.size === 0 || !(await hasPdfHeader(renderedArtifactPath))) {
      await rm(renderedArtifactPath, { force: true });
      fail("renderer did not create a non-empty PDF artifact");
    }
    hashes.artifactSha256 = await sha256File(renderedArtifactPath);
    await rename(renderedArtifactPath, artifactPath);

    const manifest = buildAuditManifest({
      request,
      templateContract,
      inputPath,
      artifactPath,
      renderedArtifactPath,
      hashes,
    });
    await atomicWriteJson(manifestPath, manifest);
    return { artifactPath, manifestPath, idempotent: false };
  });
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail(`expected --name value arguments; got ${flag ?? "end of input"}`);
    options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  const required = ["requestPath", "registerPath", "outputDir", "configPath", "templateContractPath", "invoicegenBin"];
  for (const key of required) if (!options[key]) fail(`missing --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  return options;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runDraftWorkflow(parseArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${canonicalJson(result)}`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
