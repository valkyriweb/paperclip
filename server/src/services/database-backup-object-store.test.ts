import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableObjectMetadata, ObjectStore } from "../storage/object-store.js";
import {
  materializeDatabaseBackup,
  publishDatabaseBackup,
} from "./database-backup-object-store.js";

let base: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "database-backup-object-store-"));
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function fixture() {
  const objects = new Map<string, Buffer>();
  const rows = new Map<string, DurableObjectMetadata>();
  const put = vi.fn(async (input: Parameters<ObjectStore["put"]>[0]) => {
    const body = input.body instanceof Readable
      ? await buffer(input.body)
      : input.body;
    objects.set(input.objectKey, body);
    const row: DurableObjectMetadata = {
      id: `object-${rows.size + 1}`,
      companyId: input.companyId,
      kind: input.kind,
      provider: "s3",
      backendId: "s3:test:paperclip:",
      objectKey: input.objectKey,
      contentType: input.contentType,
      byteSize: input.contentLength,
      sha256: input.sha256,
      version: "v1",
      etag: "etag-1",
      status: "committed",
      corruptionReason: null,
      verifiedAt: new Date("2026-08-25T12:00:00.000Z"),
    };
    rows.set(input.objectKey, row);
    return row;
  });
  const store: ObjectStore = {
    shared: true,
    put,
    async find(objectKey) {
      return rows.get(objectKey) ?? null;
    },
    async get(metadata) {
      const body = objects.get(metadata.objectKey);
      if (!body) throw new Error("missing object");
      return Readable.from(body);
    },
    async delete(metadata) {
      objects.delete(metadata.objectKey);
      rows.set(metadata.objectKey, { ...metadata, status: "deleted" });
    },
  };
  return { store, put, objects, rows };
}

describe("database backup durable objects", () => {
  it("publishes the exact dump bytes before a verified manifest", async () => {
    const { store, put, objects } = fixture();
    const backupFile = path.join(base, "paperclip-20260825-120000.sql.gz");
    const backup = Buffer.from("compressed database bytes");
    await fs.writeFile(backupFile, backup);

    const result = await publishDatabaseBackup({
      store,
      backupFile,
      createdAt: new Date("2026-08-25T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      byteSize: backup.length,
      sha256: createHash("sha256").update(backup).digest("hex"),
    });
    expect(result.objectKey).toMatch(
      /^system\/database-backups\/paperclip-20260825-120000-[0-9a-f-]{36}\.sql\.gz$/,
    );
    expect(result.manifestKey).toBe(`${result.objectKey}.manifest.json`);
    expect(put.mock.calls.map(([input]) => input.objectKey)).toEqual([
      result.objectKey,
      result.manifestKey,
    ]);
    expect(objects.get(result.objectKey)).toEqual(backup);
    expect(JSON.parse(objects.get(result.manifestKey)!.toString("utf8"))).toMatchObject({
      format: "paperclip-database-backup-v1",
      objectKey: result.objectKey,
      byteSize: backup.length,
      sha256: result.sha256,
    });
  });

  it("materializes a backup using only durable object metadata and streams", async () => {
    const { store } = fixture();
    const backupFile = path.join(base, "source", "paperclip-20260825-120000.sql.gz");
    const backup = Buffer.from("compressed database bytes");
    await fs.mkdir(path.dirname(backupFile), { recursive: true });
    await fs.writeFile(backupFile, backup);
    const published = await publishDatabaseBackup({
      store,
      backupFile,
      createdAt: new Date("2026-08-25T12:00:00.000Z"),
    });
    await fs.rm(path.dirname(backupFile), { recursive: true });
    const destinationFile = path.join(base, "restore", "database.sql.gz");

    const manifest = await materializeDatabaseBackup({
      store,
      manifestKey: published.manifestKey,
      destinationFile,
    });

    expect(manifest.objectKey).toBe(published.objectKey);
    expect(await fs.readFile(destinationFile)).toEqual(backup);
  });

  it("does not publish a manifest when the backup upload fails", async () => {
    const { store, put } = fixture();
    const backupFile = path.join(base, "paperclip-20260825-120000.sql.gz");
    await fs.writeFile(backupFile, "backup");
    put.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(publishDatabaseBackup({
      store,
      backupFile,
      createdAt: new Date("2026-08-25T12:00:00.000Z"),
    })).rejects.toThrow("storage unavailable");
    expect(put).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(backupFile, "utf8")).resolves.toBe("backup");
  });

  it("refuses restore when the manifest disagrees with committed backup metadata", async () => {
    const { store, rows } = fixture();
    const backupFile = path.join(base, "paperclip-20260825-120000.sql.gz");
    await fs.writeFile(backupFile, "backup");
    const published = await publishDatabaseBackup({
      store,
      backupFile,
      createdAt: new Date("2026-08-25T12:00:00.000Z"),
    });
    const row = rows.get(published.objectKey)!;
    rows.set(published.objectKey, { ...row, sha256: "0".repeat(64) });

    await expect(materializeDatabaseBackup({
      store,
      manifestKey: published.manifestKey,
      destinationFile: path.join(base, "restore.sql.gz"),
    })).rejects.toThrow("does not match committed object metadata");
  });
});
