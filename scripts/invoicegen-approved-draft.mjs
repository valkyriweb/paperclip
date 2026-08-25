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

function validateTemplateContract(contract, rendererSha256, testOnly = false) {
  exactKeys(contract, ["rendererRepo", "rendererVersion", "rendererCommit", "linuxAmd64ArchiveSha256", "linuxAmd64BinarySha256", "embeddedTemplatePath", "embeddedTemplateSha256"], "templateContract");
  if (testOnly && process.env.NODE_TEST_CONTEXT && contract.linuxAmd64BinarySha256 === rendererSha256) return;
  if (contract.rendererRepo !== "valkyriweb/invoicegen" || contract.rendererVersion !== "v0.1.2-bermont.3" || contract.rendererCommit !== "af2fb920801fe016e54da384d145da5fd1e67c41") fail("template contract does not identify the approved Invoicegen release");
  if (contract.linuxAmd64ArchiveSha256 !== "dd18719fc46c0bf26c0934445187942c591ceda5d714a020dc0effbbaeda0bee" || contract.embeddedTemplateSha256 !== "d028fab9b96c14881708175d00cd5d29647afd2cd7f106f0748b62c53785e159") fail("template contract hashes do not match the approved release");
  if (contract.linuxAmd64BinarySha256 !== rendererSha256) fail("renderer binary does not match the approved template contract");
}

function validateApprovalPayload(payload, hashes, request) {
  exactKeys(payload, ["schemaVersion", "kind", "requestSha256", "configSha256", "rendererSha256", "templateContractSha256", "numberReservation"], "approval.payload");
  if (payload.schemaVersion !== 1 || payload.kind !== "invoicegen-draft-v1") fail("approval payload kind must be invoicegen-draft-v1");
  for (const key of ["requestSha256", "configSha256", "rendererSha256", "templateContractSha256"]) {
    if (payload[key] !== hashes[key]) fail(`approval ${key} does not match the exact approved input`);
  }
  const reservation = payload.numberReservation;
  exactKeys(reservation, ["numberPrefix", "invoiceNumber", "reservedBy", "reservedAt", "evidenceReference", "iqHandoff"], "approval.payload.numberReservation");
  if (reservation.numberPrefix !== request.invoice.number_prefix || reservation.invoiceNumber !== request.invoice.number) fail("approval number reservation does not match the invoice");
  if (reservation.iqHandoff !== "human-verified") fail("approval requires a human-verified IQ handoff");
  for (const key of ["reservedBy", "reservedAt", "evidenceReference"]) {
    if (!String(reservation[key] ?? "").trim()) fail(`approval numberReservation.${key} is required`);
  }
}

function fetchPaperclipApproval(options) {
  const binary = options.paperclipaiBin ?? "paperclipai";
  const args = ["approval", "get", options.approvalId, "--profile", options.paperclipProfile ?? "bermont", "--json"];
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) fail(result.error ? `could not query Paperclip approval: ${result.error.message}` : `Paperclip approval query exited ${result.status}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`Paperclip approval response is invalid JSON: ${error.message}`);
  }
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
  const hashes = {
    requestSha256: sha256(canonicalJson(request)),
    configSha256: await sha256File(resolve(options.configPath)),
    rendererSha256: await sha256File(resolve(options.invoicegenBin)),
    templateContractSha256: await sha256File(contractPath),
  };
  validateTemplateContract(await readJson(contractPath, "template contract"), hashes.rendererSha256, options.testOnlyUseFixtureContract === true);
  return {
    schemaVersion: 1,
    kind: "invoicegen-draft-v1",
    ...hashes,
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
  const hashes = {
    requestSha256: sha256(canonicalJson(request)),
    configSha256: await sha256File(configPath),
    rendererSha256: await sha256File(invoicegenBin),
    templateContractSha256: await sha256File(templateContractPath),
  };
  validateTemplateContract(await readJson(templateContractPath, "template contract"), hashes.rendererSha256, options.testOnlyUseFixtureContract === true);
  const approval = fetchPaperclipApproval(options);
  if (approval.status !== "approved" || approval.type !== "request_board_approval") fail("Paperclip approval must be an approved request_board_approval record");
  if (!approval.decidedByUserId || !approval.decidedAt) fail("Paperclip approval must have a human decision actor and time");
  if (approval.companyId !== options.companyId) fail("Paperclip approval belongs to a different company");
  validateApprovalPayload(approval.payload, hashes, request);
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
    const stagedRendererPath = join(executionDir, ".bin", "invoicegen");
    const persistedHashes = {
      ...hashes,
      inputSha256: await sha256File(inputPath),
      artifactSha256: await sha256File(artifactPath),
    };
    if (persistedHashes.inputSha256 !== sha256(canonicalJson(request.invoice)) || (await sha256File(stagedConfigPath)) !== hashes.configSha256 || (await sha256File(stagedRendererPath)) !== hashes.rendererSha256) fail("persisted approved draft inputs were modified");
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
  await copyFile(configPath, stagedConfig);
  await copyFile(invoicegenBin, stagedRenderer);
  await chmod(stagedConfig, 0o600);
  await chmod(stagedRenderer, 0o700);
  if ((await sha256File(stagedConfig)) !== hashes.configSha256 || (await sha256File(stagedRenderer)) !== hashes.rendererSha256) fail("approved config or renderer changed while being staged");
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
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) fail("arguments must use --name value pairs");
    options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return { command, options };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const { command, options } = parseArgs(process.argv.slice(2));
  const action = command === "prepare-approval" ? prepareApproval(options) : command === "render" ? runApprovedDraft(options) : Promise.reject(new Error("usage: invoicegen-approved-draft.mjs prepare-approval|render [options]"));
  action.then((result) => process.stdout.write(canonicalJson(result))).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
