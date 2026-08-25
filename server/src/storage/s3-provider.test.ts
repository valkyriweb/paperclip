import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class {
      send = send;
    },
  };
});

import { createS3StorageProvider } from "./s3-provider.js";

function provider() {
  return createS3StorageProvider({
    bucket: "paperclip",
    region: "test-1",
    endpoint: "https://objects.example.test",
    prefix: "prod",
    forcePathStyle: true,
  });
}

describe("S3 storage provider", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("maps conditional checksum uploads and returns backend identity metadata", async () => {
    send.mockResolvedValue({
      ETag: '"etag-1"',
      VersionId: "version-1",
      ChecksumSHA256: "checksum",
    });
    const storage = provider();

    const result = await storage.putObject({
      objectKey: "company-1/assets/object-1",
      body: Buffer.from("bytes"),
      contentType: "application/octet-stream",
      contentLength: 5,
      checksumSha256: "checksum",
      ifNoneMatch: true,
    });

    expect(storage.backendId).toBe("s3:https://objects.example.test:paperclip:prod");
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: "paperclip",
      Key: "prod/company-1/assets/object-1",
      ChecksumSHA256: "checksum",
      IfNoneMatch: "*",
    });
    expect(result).toEqual({
      etag: '"etag-1"',
      version: "version-1",
      checksumSha256: "checksum",
    });
  });

  it("maps conditional conflicts to an HTTP conflict", async () => {
    send.mockRejectedValue(Object.assign(new Error("precondition failed"), {
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    }));

    await expect(provider().putObject({
      objectKey: "company-1/assets/object-1",
      body: Buffer.from("bytes"),
      contentType: "application/octet-stream",
      contentLength: 5,
      ifNoneMatch: true,
    })).rejects.toMatchObject({ status: 409 });
  });

  it("pins reads, heads, and deletes to the requested version", async () => {
    send
      .mockResolvedValueOnce({ Body: { arrayBuffer: async () => Buffer.from("bytes") }, VersionId: "version-1" })
      .mockResolvedValueOnce({ ContentLength: 5, VersionId: "version-1" })
      .mockResolvedValueOnce({});
    const storage = provider();

    await storage.getObject({ objectKey: "company-1/assets/object-1", version: "version-1" });
    await storage.headObject({ objectKey: "company-1/assets/object-1", version: "version-1" });
    await storage.deleteObject({ objectKey: "company-1/assets/object-1", version: "version-1" });

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ VersionId: "version-1" });
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[1]?.[0].input).toMatchObject({ VersionId: "version-1", ChecksumMode: "ENABLED" });
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[2]?.[0].input).toMatchObject({ VersionId: "version-1" });
  });
});
