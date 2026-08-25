#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTER_SCHEMA_VERSION = 1;
const REQUEST_SCHEMA_VERSION = 1;
const SYNTHETIC_NUMBER_MIN = 990000;
const SYNTHETIC_NUMBER_MAX = 999999;
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

function validateRequest(request) {
  if (request.schemaVersion !== REQUEST_SCHEMA_VERSION) fail("request schemaVersion must be 1");
  if (request.mode !== "synthetic") fail("mode must be synthetic; real client data requires a separate human-approved workflow");
  if (request.state !== "draft") fail("state must be draft; this tool cannot approve, issue, or send invoices");
  if (!/^synthetic-[a-z0-9-]{8,80}$/.test(request.idempotencyKey ?? "")) {
    fail("idempotencyKey must start with synthetic- and contain only lowercase letters, digits, and hyphens");
  }

  const invoice = request.invoice;
  if (!invoice || typeof invoice !== "object") fail("invoice is required");
  if (!Number.isInteger(invoice.number) || invoice.number < SYNTHETIC_NUMBER_MIN || invoice.number > SYNTHETIC_NUMBER_MAX) {
    fail(`synthetic invoice number must be an integer from ${SYNTHETIC_NUMBER_MIN} to ${SYNTHETIC_NUMBER_MAX}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.date ?? "")) fail("invoice date must use YYYY-MM-DD");
  if (invoice.sender?.name !== "SYNTHETIC TEST SENDER") fail("sender must be SYNTHETIC TEST SENDER");
  if (!String(invoice.client?.bill_to ?? "").startsWith("SYNTHETIC TEST CLIENT\n")) {
    fail("bill_to must start with the synthetic client marker");
  }
  if (!String(invoice.client?.ship_to ?? "").startsWith("SYNTHETIC TEST CLIENT\n")) {
    fail("ship_to must start with the synthetic client marker");
  }
  if (!String(invoice.notes ?? "").includes("NOT FOR ISSUE OR SEND")) {
    fail("notes must include NOT FOR ISSUE OR SEND");
  }
  if (!Array.isArray(invoice.items) || invoice.items.length === 0) fail("at least one synthetic line item is required");

  let subtotal = 0;
  for (const item of invoice.items) {
    if (!String(item.description ?? "").toLowerCase().includes("synthetic")) fail("every item description must be synthetic");
    if (!Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.rate) || item.rate < 0) {
      fail("synthetic item quantity and rate must be finite non-negative numbers");
    }
    subtotal += item.quantity * item.rate;
  }
  if (subtotal > 100) fail("synthetic subtotal must not exceed 100");

  const serialized = canonicalJson(request);
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(serialized)) fail("synthetic requests must not contain email addresses");
  for (const forbiddenKey of ["recipient", "email", "send", "issuedAt", "approvedAt"]) {
    if (Object.hasOwn(request, forbiddenKey) || Object.hasOwn(invoice, forbiddenKey)) {
      fail(`field ${forbiddenKey} is not allowed in a synthetic draft`);
    }
  }
}

function validateTemplateContract(contract) {
  if (contract.rendererRepo !== "valkyriweb/invoicegen" || contract.rendererVersion !== "v0.1.2-bermont.1") {
    fail("template contract must identify the pinned Bermont Invoicegen release");
  }
  if (!/^[a-f0-9]{40}$/.test(contract.rendererCommit ?? "")) fail("template contract rendererCommit must be an exact commit");
  if (contract.embeddedTemplatePath !== "templates/invoice-minimal.typ") fail("unexpected embedded template path");
  if (!/^[a-f0-9]{64}$/.test(contract.embeddedTemplateSha256 ?? "")) fail("template contract must contain an exact SHA-256");
}

async function withLock(registerPath, action) {
  const lockPath = `${registerPath}.lock`;
  await mkdir(dirname(registerPath), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        return await action();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_DELAY_MS));
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
  const hashes = {
    requestSha256,
    configSha256: await sha256File(configPath),
    templateSha256: templateContract.embeddedTemplateSha256,
    templateContractSha256: sha256Bytes(canonicalJson(templateContract)),
    rendererSha256: await sha256File(invoicegenBin),
  };
  await reserveSyntheticNumber(registerPath, request, requestSha256);

  const executionId = `${request.invoice.number}-${sha256Bytes(request.idempotencyKey).slice(0, 12)}`;
  const executionDir = join(outputDir, executionId);
  const inputPath = join(executionDir, `draft-${request.invoice.number}.yaml`);
  const artifactPath = join(executionDir, `draft-${request.invoice.number}.pdf`);
  const manifestPath = join(executionDir, "audit-manifest.json");
  const configHome = join(executionDir, ".config", "invoicegen");
  const invoiceInput = canonicalJson(request.invoice);
  hashes.inputSha256 = sha256Bytes(invoiceInput);

  return withLock(manifestPath, async () => {
    try {
      const manifest = await readJson(manifestPath, "existing audit manifest");
      for (const [key, value] of Object.entries(hashes)) {
        if (manifest.hashes?.[key] !== value) fail(`existing manifest ${key} does not match this execution`);
      }
      const persistedInputSha256 = await sha256File(inputPath);
      if (manifest.hashes?.inputSha256 !== persistedInputSha256) {
        fail("existing input hash does not match its audit manifest");
      }
      const persistedConfigSha256 = await sha256File(join(configHome, "config.yaml"));
      if (manifest.hashes?.configSha256 !== persistedConfigSha256) {
        fail("existing config hash does not match its audit manifest");
      }
      const artifactSha256 = await sha256File(artifactPath);
      if (manifest.hashes?.artifactSha256 !== artifactSha256) {
        fail("existing artifact hash does not match its audit manifest");
      }
      return { artifactPath, manifestPath, idempotent: true };
    } catch (error) {
      if (!error.message.includes("cannot read existing audit manifest") || !error.message.includes("ENOENT")) throw error;
    }

    await mkdir(configHome, { recursive: true });
    await copyFile(configPath, join(configHome, "config.yaml"));
    await chmod(join(configHome, "config.yaml"), 0o600);
    await writeFile(inputPath, invoiceInput, { mode: 0o600 });

    const result = spawnSync(invoicegenBin, ["generate", inputPath, "-o", artifactPath], {
      cwd: executionDir,
      env: { ...env, XDG_CONFIG_HOME: join(executionDir, ".config") },
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error) fail(`renderer did not execute: ${result.error.message}`);
    if (result.status !== 0) {
      fail(`renderer exited with status ${result.status}; draft remains reserved and can be retried`);
    }
    const artifactStat = await stat(artifactPath).catch(() => null);
    if (!artifactStat?.isFile() || artifactStat.size === 0) {
      fail("renderer did not create a non-empty PDF artifact");
    }
    hashes.artifactSha256 = await sha256File(artifactPath);

    const manifest = {
      schemaVersion: 1,
      workflowState: "draft",
      idempotencyKey: request.idempotencyKey,
      invoiceNumber: request.invoice.number,
      renderer: {
        repository: templateContract.rendererRepo,
        version: templateContract.rendererVersion,
        commit: templateContract.rendererCommit,
        invocation: ["generate", basename(inputPath), "-o", basename(artifactPath)],
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
