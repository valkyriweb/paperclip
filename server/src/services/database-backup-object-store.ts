import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { ObjectStore } from "../storage/object-store.js";

const BACKUP_CONTENT_TYPE = "application/gzip";
const MANIFEST_CONTENT_TYPE = "application/json";

export interface DatabaseBackupManifest {
  format: "paperclip-database-backup-v1";
  createdAt: string;
  objectKey: string;
  byteSize: number;
  sha256: string;
}

export interface PublishedDatabaseBackup {
  objectKey: string;
  manifestKey: string;
  byteSize: number;
  sha256: string;
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function backupObjectKey(backupFile: string): string {
  const filename = path.basename(backupFile);
  const stem = filename.endsWith(".sql.gz")
    ? filename.slice(0, -".sql.gz".length)
    : filename;
  return `system/database-backups/${stem}-${randomUUID()}.sql.gz`;
}

export async function publishDatabaseBackup(input: {
  store: ObjectStore;
  backupFile: string;
  createdAt: Date;
}): Promise<PublishedDatabaseBackup> {
  if (!input.store.shared) {
    throw new Error("Database backup publication requires shared storage");
  }

  const stat = await fs.stat(input.backupFile);
  const sha256 = await sha256File(input.backupFile);
  const objectKey = backupObjectKey(input.backupFile);
  await input.store.put({
    companyId: null,
    kind: "database_backup",
    objectKey,
    contentType: BACKUP_CONTENT_TYPE,
    body: createReadStream(input.backupFile),
    contentLength: stat.size,
    sha256,
  });

  const manifest: DatabaseBackupManifest = {
    format: "paperclip-database-backup-v1",
    createdAt: input.createdAt.toISOString(),
    objectKey,
    byteSize: stat.size,
    sha256,
  };
  const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestKey = `${objectKey}.manifest.json`;
  await input.store.put({
    companyId: null,
    kind: "database_backup",
    objectKey: manifestKey,
    contentType: MANIFEST_CONTENT_TYPE,
    body: manifestBody,
    contentLength: manifestBody.length,
    sha256: createHash("sha256").update(manifestBody).digest("hex"),
  });

  return { objectKey, manifestKey, byteSize: stat.size, sha256 };
}

export async function materializeDatabaseBackup(input: {
  store: ObjectStore;
  manifestKey: string;
  destinationFile: string;
}): Promise<DatabaseBackupManifest> {
  const manifestMetadata = await input.store.find(input.manifestKey);
  if (!manifestMetadata) throw new Error("Database backup manifest not found");
  const manifestStream = await input.store.get(manifestMetadata);
  const chunks: Buffer[] = [];
  for await (const chunk of manifestStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<DatabaseBackupManifest>;
  if (
    parsed.format !== "paperclip-database-backup-v1" ||
    typeof parsed.createdAt !== "string" ||
    typeof parsed.objectKey !== "string" ||
    typeof parsed.byteSize !== "number" ||
    !Number.isSafeInteger(parsed.byteSize) ||
    parsed.byteSize < 0 ||
    typeof parsed.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed.sha256)
  ) {
    throw new Error("Invalid database backup manifest");
  }
  const manifest = parsed as DatabaseBackupManifest;
  if (!manifest.objectKey.startsWith("system/database-backups/")) {
    throw new Error("Invalid database backup object key");
  }

  const backupMetadata = await input.store.find(manifest.objectKey);
  if (!backupMetadata) throw new Error("Database backup object not found");
  if (backupMetadata.byteSize !== manifest.byteSize || backupMetadata.sha256 !== manifest.sha256) {
    throw new Error("Database backup manifest does not match committed object metadata");
  }

  await fs.mkdir(path.dirname(input.destinationFile), { recursive: true });
  const temporaryFile = `${input.destinationFile}.tmp`;
  try {
    await pipeline(await input.store.get(backupMetadata), createWriteStream(temporaryFile, { flags: "wx" }));
    await fs.rename(temporaryFile, input.destinationFile);
  } catch (error) {
    await fs.unlink(temporaryFile).catch(() => undefined);
    throw error;
  }
  return manifest;
}
