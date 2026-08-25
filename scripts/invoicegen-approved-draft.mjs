#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(`invoicegen approved draft: ${message}`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`cannot read valid ${label} JSON at ${path}: ${error.message}`);
  }
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`unknown field ${label}.${key}`);
  }
}

function rejectEffectFields(value) {
  const denied = new Set(["approve", "approved", "approval", "issue", "issued", "issuance", "send", "sent", "sentat"]);
  if (Array.isArray(value)) return value.forEach(rejectEffectFields);
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (denied.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) fail(`effect field ${key} is forbidden in a draft request`);
    rejectEffectFields(child);
  }
}

function validateRequest(request) {
  rejectEffectFields(request);
  exactKeys(request, ["schemaVersion", "state", "idempotencyKey", "invoice"], "request");
  if (request.schemaVersion !== 1) fail("request schemaVersion must be 1");
  if (request.state !== "draft") fail("request state must be draft");
  if (!/^[a-z0-9][a-z0-9-]{7,80}$/.test(request.idempotencyKey ?? "")) fail("invalid idempotencyKey");

  const invoice = request.invoice;
  exactKeys(invoice, ["number", "number_prefix", "draft", "date", "client", "po_number", "notes", "tax_rate", "tax_note", "items"], "invoice");
  if (!Number.isInteger(invoice.number) || invoice.number < 1 || invoice.number > 999_999) fail("invoice number must be an integer from 1 to 999999");
  if (invoice.number_prefix !== "INVBD") fail("invoice number_prefix must be INVBD");
  if (invoice.draft !== true) fail("invoice.draft must be true so the PDF is visibly marked as not issued");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.date ?? "")) fail("invoice date must use YYYY-MM-DD");
  exactKeys(invoice.client, ["bill_to", "ship_to", "default_rate"], "invoice.client");
  if (!String(invoice.client.bill_to ?? "").trim()) fail("invoice.client.bill_to is required");
  if (typeof invoice.client.ship_to !== "string") fail("invoice.client.ship_to must be a string");
  if (!Number.isFinite(invoice.client.default_rate) || invoice.client.default_rate < 0) fail("invoice.client.default_rate must be non-negative");
  if (!Number.isFinite(invoice.tax_rate) || invoice.tax_rate < 0) fail("invoice.tax_rate must be non-negative");
  if (invoice.po_number != null && typeof invoice.po_number !== "string") fail("invoice.po_number must be a string or null");
  if (invoice.notes != null && typeof invoice.notes !== "string") fail("invoice.notes must be a string or null");
  if (invoice.tax_note != null && typeof invoice.tax_note !== "string") fail("invoice.tax_note must be a string or null");
  if (!Array.isArray(invoice.items) || invoice.items.length === 0) fail("invoice.items must not be empty");
  for (const [index, item] of invoice.items.entries()) {
    exactKeys(item, ["description", "quantity", "rate"], `invoice.items[${index}]`);
    if (!String(item.description ?? "").trim()) fail(`invoice.items[${index}].description is required`);
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) fail(`invoice.items[${index}].quantity must be positive`);
    if (!Number.isFinite(item.rate) || item.rate < 0) fail(`invoice.items[${index}].rate must be non-negative`);
  }
}

function validateTemplateContract(contract, rendererSha256) {
  exactKeys(contract, ["rendererRepo", "rendererVersion", "rendererCommit", "linuxAmd64ArchiveSha256", "linuxAmd64BinarySha256", "embeddedTemplatePath", "embeddedTemplateSha256"], "templateContract");
  if (contract.rendererRepo !== "valkyriweb/invoicegen" || contract.rendererVersion !== "v0.1.2-bermont.3" || contract.rendererCommit !== "af2fb920801fe016e54da384d145da5fd1e67c41") fail("template contract does not identify the approved Invoicegen release");
  if (contract.linuxAmd64ArchiveSha256 !== "dd18719fc46c0bf26c0934445187942c591ceda5d714a020dc0effbbaeda0bee" || contract.linuxAmd64BinarySha256 !== "907ce7ce767e82bbc9fd9d8a3dc1cf9cdf8c0d6dfe32e184aec9e161f0675ba5" || contract.embeddedTemplateSha256 !== "d028fab9b96c14881708175d00cd5d29647afd2cd7f106f0748b62c53785e159") fail("template contract hashes do not match the approved release");
  if (contract.linuxAmd64BinarySha256 !== rendererSha256) fail("renderer binary does not match the approved template contract");
}

function configScalar(configText, section, key, required = true) {
  const lines = configText.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => new RegExp(`^${section}:\\s*(?:#.*)?$`).test(line));
  if (sectionIndex < 0) {
    if (!required) return null;
    fail(`config.${section} is required`);
  }
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index])) break;
    const match = lines[index].match(new RegExp(`^\\s+${key}:\\s*([^#]+?)\\s*(?:#.*)?$`));
    if (match) return match[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!required) return null;
  fail(`config.${section}.${key} is required`);
}

async function validateBermontConfig(configText) {
  const identity = {
    senderName: configScalar(configText, "sender", "name"),
    currency: configScalar(configText, "defaults", "currency"),
    numberPrefix: configScalar(configText, "defaults", "number_prefix"),
  };
  if (!/^Bermont Digital(?:\b|\s|\()/.test(identity.senderName)) fail("config sender must identify Bermont Digital");
  if (identity.currency !== "ZAR") fail("config defaults.currency must be ZAR");
  if (identity.numberPrefix !== "INVBD") fail("config defaults.number_prefix must be INVBD");
  const logoPath = configScalar(configText, "sender", "logo", false);
  if (logoPath && logoPath !== "/paperclip/.config/invoicegen/logo.svg") fail("config sender.logo must use the managed Bermont logo path");
  identity.logoSha256 = logoPath ? await sha256File(logoPath) : null;
  return { identity, logoPath };
}

function validateApprovalPayload(payload, hashes, request, configIdentity) {
  exactKeys(payload, ["schemaVersion", "kind", "requestSha256", "configSha256", "rendererSha256", "templateContractSha256", "logoSha256", "configIdentity", "numberReservation"], "approval.payload");
  if (payload.schemaVersion !== 1 || payload.kind !== "invoicegen-draft-v1") fail("approval payload kind must be invoicegen-draft-v1");
  for (const key of ["requestSha256", "configSha256", "rendererSha256", "templateContractSha256", "logoSha256"]) {
    if (payload[key] !== hashes[key]) fail(`approval ${key} does not match the exact approved input`);
  }
  exactKeys(payload.configIdentity, ["senderName", "currency", "numberPrefix", "logoSha256"], "approval.payload.configIdentity");
  if (canonicalJson(payload.configIdentity) !== canonicalJson(configIdentity)) fail("approval configIdentity does not match the reviewed Bermont config");
  const reservation = payload.numberReservation;
  exactKeys(reservation, ["numberPrefix", "invoiceNumber", "reservedBy", "reservedAt", "evidenceReference", "iqHandoff"], "approval.payload.numberReservation");
  if (reservation.numberPrefix !== request.invoice.number_prefix || reservation.invoiceNumber !== request.invoice.number) fail("approval number reservation does not match the invoice");
  if (reservation.iqHandoff !== "human-verified") fail("approval requires a human-verified IQ handoff");
  for (const key of ["reservedBy", "reservedAt", "evidenceReference"]) {
    if (!String(reservation[key] ?? "").trim()) fail(`approval numberReservation.${key} is required`);
  }
}

function fetchPaperclipApproval(options) {
  const cliScript = "/app/cli/dist/index.js";
  const args = [cliScript, "approval", "get", options.approvalId, "--api-base", "http://127.0.0.1:3100", "--profile", "bermont", "--json"];
  const env = {
    HOME: "/paperclip",
    NODE_ENV: "production",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    ...(process.env.PAPERCLIP_API_KEY ? { PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY } : {}),
  };
  const result = spawnSync(process.execPath, args, { cwd: "/app", env, encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) fail(result.error ? `could not query Paperclip approval: ${result.error.message}` : `Paperclip approval query exited ${result.status}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`Paperclip approval response is invalid JSON: ${error.message}`);
  }
}

function buildStagedConfig(configText, logoPath, stagedLogoPath) {
  if (!logoPath) return configText;
  const pattern = /^(\s*logo:\s*).*$/m;
  if (!pattern.test(configText)) fail("managed logo path is missing from config during staging");
  return configText.replace(pattern, `$1${stagedLogoPath}`);
}

async function hasPdfHeader(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await handle.read(header, 0, 5, 0);
    return bytesRead === 5 && header.toString("ascii") === "%PDF-";
  } finally {
    await handle.close();
  }
}

async function withFileLock(targetPath, action) {
  const lockPath = `${targetPath}.lock`;
  const token = randomUUID();
  await mkdir(dirname(targetPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") fail(`workflow is locked at ${lockPath}; inspect its owner before manual cleanup`);
    throw error;
  }
  await handle.writeFile(canonicalJson({ schemaVersion: 1, pid: process.pid, hostname: process.env.HOSTNAME ?? "unknown", token }));
  try {
    return await action();
  } finally {
    await handle.close();
    const owner = await readJson(lockPath, "lock owner").catch(() => null);
    if (owner?.token === token) await unlink(lockPath).catch(() => {});
  }
}

function validateReservations(reservations) {
  const numbers = new Set();
  const keys = new Set();
  for (const entry of reservations) {
    exactKeys(entry, ["numberPrefix", "invoiceNumber", "idempotencyKey", "requestSha256", "approvalSha256", "state", "reservationKind"], "reservation");
    if (entry.numberPrefix !== "INVBD" || !Number.isInteger(entry.invoiceNumber) || !/^[a-f0-9]{64}$/.test(entry.requestSha256 ?? "") || !/^[a-f0-9]{64}$/.test(entry.approvalSha256 ?? "") || entry.state !== "draft-reserved" || entry.reservationKind !== "human-approved-iq-handoff") fail("number register contains an invalid reservation");
    if (numbers.has(entry.invoiceNumber) || keys.has(entry.idempotencyKey)) fail("number register contains duplicate reservations");
    numbers.add(entry.invoiceNumber);
    keys.add(entry.idempotencyKey);
  }
}

async function reserveNumber(registerPath, request, approvalSha256, requestSha256) {
  return withFileLock(registerPath, async () => {
    let register;
    try {
      register = await readJson(registerPath, "number register");
    } catch (error) {
      if (!error.message.includes("ENOENT")) throw error;
      register = { schemaVersion: 1, namespace: "invoicegen-approved-drafts-v1", reservations: [] };
    }
    if (register.schemaVersion !== 1 || register.namespace !== "invoicegen-approved-drafts-v1" || !Array.isArray(register.reservations)) fail("unsupported number register");
    validateReservations(register.reservations);
    for (const entry of register.reservations) {
      if (entry.numberPrefix === request.invoice.number_prefix && entry.invoiceNumber === request.invoice.number && entry.idempotencyKey !== request.idempotencyKey) fail(`invoice ${request.invoice.number_prefix}${request.invoice.number} is already reserved`);
      if (entry.idempotencyKey === request.idempotencyKey && (entry.invoiceNumber !== request.invoice.number || entry.requestSha256 !== requestSha256 || entry.approvalSha256 !== approvalSha256)) fail("idempotency key is already bound to different invoice content or approval");
    }
    const existing = register.reservations.find((entry) => entry.idempotencyKey === request.idempotencyKey);
    if (existing) return existing;
    const entry = { numberPrefix: request.invoice.number_prefix, invoiceNumber: request.invoice.number, idempotencyKey: request.idempotencyKey, requestSha256, approvalSha256, state: "draft-reserved", reservationKind: "human-approved-iq-handoff" };
    register.reservations.push(entry);
    const temporary = `${registerPath}.tmp-${process.pid}`;
    await writeFile(temporary, canonicalJson(register), { mode: 0o600 });
    await rename(temporary, registerPath);
    return entry;
  });
}

export async function prepareApproval(options) {
  const request = await readJson(resolve(options.requestPath), "request");
  validateRequest(request);
  const contractPath = resolve(options.templateContractPath);
  const configBuffer = await readFile(resolve(options.configPath));
  const hashes = {
    requestSha256: sha256(canonicalJson(request)),
    configSha256: sha256(configBuffer),
    rendererSha256: await sha256File(resolve(options.invoicegenBin)),
    templateContractSha256: await sha256File(contractPath),
  };
  validateTemplateContract(await readJson(contractPath, "template contract"), hashes.rendererSha256);
  const { identity: configIdentity } = await validateBermontConfig(configBuffer.toString("utf8"));
  hashes.logoSha256 = configIdentity.logoSha256;
  return {
    schemaVersion: 1,
    kind: "invoicegen-draft-v1",
    ...hashes,
    configIdentity,
    numberReservation: { numberPrefix: request.invoice.number_prefix, invoiceNumber: request.invoice.number, reservedBy: "", reservedAt: "", evidenceReference: "", iqHandoff: "pending-human-verification" },
  };
}

function buildManifest(request, approval, hashes, inputPath, artifactPath) {
  return { schemaVersion: 1, workflowState: "draft", invoiceIdentity: `${request.invoice.number_prefix}${request.invoice.number}`, idempotencyKey: request.idempotencyKey, approval: { approvalId: approval.id, approvedByUserId: approval.decidedByUserId, approvedAt: approval.decidedAt, evidenceReference: approval.payload.numberReservation.evidenceReference }, safety: { iqAccess: "human-only", issueCapability: "absent", sendCapability: "absent" }, hashes, files: { input: basename(inputPath), artifact: basename(artifactPath) } };
}

export async function runApprovedDraft(options) {
  if (!options.companyId) fail("--company-id is required");
  const requestPath = resolve(options.requestPath);
  if (!options.approvalId) fail("--approval-id is required");
  const configPath = resolve(options.configPath);
  const invoicegenBin = resolve(options.invoicegenBin);
  const templateContractPath = resolve(options.templateContractPath);
  const registerPath = resolve(options.registerPath);
  const outputDir = resolve(options.outputDir);
  const request = await readJson(requestPath, "request");
  validateRequest(request);
  const configBuffer = await readFile(configPath);
  const configText = configBuffer.toString("utf8");
  const hashes = {
    requestSha256: sha256(canonicalJson(request)),
    configSha256: sha256(configBuffer),
    rendererSha256: await sha256File(invoicegenBin),
    templateContractSha256: await sha256File(templateContractPath),
  };
  validateTemplateContract(await readJson(templateContractPath, "template contract"), hashes.rendererSha256);
  const { identity: configIdentity, logoPath } = await validateBermontConfig(configText);
  hashes.logoSha256 = configIdentity.logoSha256;
  const approval = fetchPaperclipApproval(options);
  if (approval.status !== "approved" || approval.type !== "request_board_approval") fail("Paperclip approval must be an approved request_board_approval record");
  if (!approval.decidedByUserId || !approval.decidedAt) fail("Paperclip approval must have a human decision actor and time");
  if (approval.companyId !== options.companyId) fail("Paperclip approval belongs to a different company");
  validateApprovalPayload(approval.payload, hashes, request, configIdentity);
  hashes.approvalSha256 = sha256(canonicalJson(approval));
  await reserveNumber(registerPath, request, hashes.approvalSha256, hashes.requestSha256);

  const executionDir = join(outputDir, `${request.invoice.number_prefix}${request.invoice.number}-${sha256(request.idempotencyKey).slice(0, 12)}`);
  const inputPath = join(executionDir, `${request.invoice.number_prefix}${request.invoice.number}.yaml`);
  const artifactPath = join(executionDir, `${request.invoice.number_prefix}${request.invoice.number}-DRAFT.pdf`);
  const renderingPath = `${artifactPath}.rendering`;
  const manifestPath = join(executionDir, "audit-manifest.json");
  await mkdir(executionDir, { recursive: true });

  return withFileLock(manifestPath, async () => {
  let existing = null;
  try {
    existing = await readJson(manifestPath, "audit manifest");
  } catch (error) {
    if (!error.message.includes("ENOENT")) throw error;
  }
  if (existing) {
    const stagedConfigPath = join(executionDir, ".config", "invoicegen", "config.yaml");
    const stagedLogoPath = join(executionDir, ".config", "invoicegen", "logo.svg");
    const stagedRendererPath = join(executionDir, ".bin", "invoicegen");
    const persistedHashes = {
      ...hashes,
      inputSha256: await sha256File(inputPath),
      artifactSha256: await sha256File(artifactPath),
    };
    const expectedStagedConfig = buildStagedConfig(configText, logoPath, stagedLogoPath);
    if (persistedHashes.inputSha256 !== sha256(canonicalJson(request.invoice)) || (await sha256File(stagedConfigPath)) !== sha256(expectedStagedConfig) || (await sha256File(stagedRendererPath)) !== hashes.rendererSha256 || (logoPath && (await sha256File(stagedLogoPath)) !== hashes.logoSha256)) fail("persisted approved draft inputs were modified");
    const expected = buildManifest(request, approval, persistedHashes, inputPath, artifactPath);
    if (canonicalJson(existing) !== canonicalJson(expected)) fail("existing draft manifest does not match the approved execution");
    return { artifactPath, manifestPath, idempotent: true };
  }
  if (await stat(artifactPath).catch(() => null)) fail("draft artifact exists without its audit manifest; preserve it for operator recovery");

  const configHome = join(executionDir, ".config", "invoicegen");
  const stagedRenderer = join(executionDir, ".bin", "invoicegen");
  await mkdir(configHome, { recursive: true });
  await mkdir(dirname(stagedRenderer), { recursive: true });
  const stagedConfig = join(configHome, "config.yaml");
  const stagedLogo = join(configHome, "logo.svg");
  if (logoPath && (await sha256File(logoPath)) !== hashes.logoSha256) fail("approved logo changed before staging");
  if (logoPath) {
    await copyFile(logoPath, stagedLogo);
    await chmod(stagedLogo, 0o600);
  }
  const stagedConfigText = buildStagedConfig(configText, logoPath, stagedLogo);
  await writeFile(stagedConfig, stagedConfigText, { mode: 0o600 });
  await copyFile(invoicegenBin, stagedRenderer);
  await chmod(stagedRenderer, 0o700);
  if ((await sha256File(stagedConfig)) !== sha256(stagedConfigText) || (logoPath && (await sha256File(stagedLogo)) !== hashes.logoSha256) || (await sha256File(stagedRenderer)) !== hashes.rendererSha256) fail("approved config, logo, or renderer changed while being staged");
  await writeFile(inputPath, canonicalJson(request.invoice), { mode: 0o600 });
  await rm(renderingPath, { force: true });
  const result = spawnSync(stagedRenderer, ["generate", inputPath, "-o", renderingPath], { cwd: executionDir, env: { ...process.env, XDG_CONFIG_HOME: join(executionDir, ".config") }, encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) {
    await rm(renderingPath, { force: true });
    fail(result.error ? `renderer failed: ${result.error.message}` : `renderer exited ${result.status}`);
  }
  const artifactStat = await stat(renderingPath).catch(() => null);
  if (!artifactStat?.isFile() || artifactStat.size === 0 || !(await hasPdfHeader(renderingPath))) {
    await rm(renderingPath, { force: true });
    fail("renderer did not produce a valid PDF draft");
  }
  await chmod(renderingPath, 0o600);
  hashes.inputSha256 = await sha256File(inputPath);
  hashes.artifactSha256 = await sha256File(renderingPath);
  await rename(renderingPath, artifactPath);
  const manifest = buildManifest(request, approval, hashes, inputPath, artifactPath);
  const temporaryManifest = `${manifestPath}.tmp-${process.pid}`;
  await writeFile(temporaryManifest, canonicalJson(manifest), { mode: 0o600 });
  await rename(temporaryManifest, manifestPath);
  return { artifactPath, manifestPath, idempotent: false };
  });
}

function parseArgs(argv) {
  const command = argv.shift();
  const common = ["request-path", "config-path", "invoicegen-bin", "template-contract-path"];
  const allowed = new Set(command === "prepare-approval"
    ? common
    : command === "render"
      ? [...common, "approval-id", "company-id", "register-path", "output-dir"]
      : []);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) fail("arguments must use --name value pairs");
    const name = key.slice(2);
    if (!allowed.has(name)) fail(`unsupported ${command ?? "unknown"} option --${name}`);
    options[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return { command, options };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const { command, options } = parseArgs(process.argv.slice(2));
  const action = command === "prepare-approval" ? prepareApproval(options) : command === "render" ? runApprovedDraft(options) : Promise.reject(new Error("usage: invoicegen-approved-draft.mjs prepare-approval|render [options]"));
  action.then((result) => process.stdout.write(canonicalJson(result))).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
