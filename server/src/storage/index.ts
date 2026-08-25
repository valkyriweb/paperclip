import type { Db } from "@paperclipai/db";
import { loadConfig, type Config } from "../config.js";
import {
  createDrizzleDurableObjectMetadataStore,
  createObjectStore,
  type ObjectStore,
} from "./object-store.js";
import { createS3StorageProviderFromConfig, createStorageProviderFromConfig } from "./provider-registry.js";
import { createStorageService } from "./service.js";
import type { StorageProvider, StorageService } from "./types.js";

let cachedStorageService: StorageService | null = null;
let cachedSignature: string | null = null;
let cachedStorageProvider: StorageProvider | null = null;
let cachedProviderSignature: string | null = null;
let cachedArchiveProvider: StorageProvider | null = null;
let cachedArchiveSignature: string | null = null;
let cachedArchiveObjectStore: ObjectStore | null = null;
let cachedArchiveObjectStoreSignature: string | null = null;

function signatureForConfig(config: Config): string {
  return JSON.stringify({
    provider: config.storageProvider,
    localDisk: config.storageLocalDiskBaseDir,
    s3Bucket: config.storageS3Bucket,
    s3Region: config.storageS3Region,
    s3Endpoint: config.storageS3Endpoint,
    s3Prefix: config.storageS3Prefix,
    s3ForcePathStyle: config.storageS3ForcePathStyle,
  });
}

export function createStorageServiceFromConfig(config: Config, db?: Db): StorageService {
  const provider = createStorageProviderFromConfig(config);
  const durableStore = db
    ? createObjectStore({
        provider,
        metadata: createDrizzleDurableObjectMetadataStore(db),
      })
    : undefined;
  return createStorageService(provider, durableStore);
}

export function createObjectStoreFromConfig(config: Config, db: Db): ObjectStore {
  return createObjectStore({
    provider: createStorageProviderFromConfig(config),
    metadata: createDrizzleDurableObjectMetadataStore(db),
  });
}

export function createSharedObjectStoreFromConfig(config: Config, db: Db): ObjectStore | null {
  if (config.storageProvider !== "s3") return null;
  return createObjectStoreFromConfig(config, db);
}

export function initializeStorageService(config: Config, db: Db): StorageService {
  cachedStorageService = createStorageServiceFromConfig(config, db);
  cachedSignature = signatureForConfig(config);
  return cachedStorageService;
}

export function getStorageService(): StorageService {
  const config = loadConfig();
  const signature = signatureForConfig(config);
  if (!cachedStorageService || cachedSignature !== signature) {
    cachedStorageService = createStorageServiceFromConfig(config);
    cachedSignature = signature;
  }
  return cachedStorageService;
}

/**
 * The raw, non-company-scoped {@link StorageProvider} behind the facade. The
 * company-scoped {@link StorageService} enforces a `<companyId>/` object-key
 * prefix for tenant-facing artifact requests. Internal callers that need the
 * provider facade without the file-service API use this accessor; durable
 * run-log archives use their metadata-backed object store instead.
 */
export function getStorageProvider(): StorageProvider {
  const config = loadConfig();
  const signature = signatureForConfig(config);
  if (!cachedStorageProvider || cachedProviderSignature !== signature) {
    cachedStorageProvider = createStorageProviderFromConfig(config);
    cachedProviderSignature = signature;
  }
  return cachedStorageProvider;
}

/**
 * Storage provider for the run-log cold-archive leg (archive writes + `s3`-tier
 * reads). When `PAPERCLIP_RUN_LOG_ARCHIVE=s3` (forced mode) this returns an S3
 * provider built straight from the `storageS3*` config, so a deployment can keep
 * its primary storage on local_disk while still archiving/retrieving run logs
 * from object storage. Any other mode delegates to the app-wide
 * {@link getStorageProvider}, so archive and retrieval always share one provider.
 */
export function getRunLogArchiveStorageProvider(): StorageProvider {
  const config = loadConfig();
  if (config.runLogArchiveMode !== "s3") return getStorageProvider();
  const signature = signatureForConfig(config);
  if (!cachedArchiveProvider || cachedArchiveSignature !== signature) {
    cachedArchiveProvider = createS3StorageProviderFromConfig(config);
    cachedArchiveSignature = signature;
  }
  return cachedArchiveProvider;
}

export function initializeRunLogArchiveObjectStore(config: Config, db: Db): ObjectStore {
  const signature = signatureForConfig(config);
  const provider = config.runLogArchiveMode === "s3"
    ? createS3StorageProviderFromConfig(config)
    : createStorageProviderFromConfig(config);
  cachedArchiveObjectStore = createObjectStore({
    provider,
    metadata: createDrizzleDurableObjectMetadataStore(db),
  });
  cachedArchiveObjectStoreSignature = signature;
  return cachedArchiveObjectStore;
}

export function getRunLogArchiveObjectStore(): ObjectStore | null {
  const config = loadConfig();
  const signature = signatureForConfig(config);
  if (cachedArchiveObjectStoreSignature !== signature) return null;
  return cachedArchiveObjectStore;
}

export type { StorageProvider, StorageService, PutFileResult } from "./types.js";
