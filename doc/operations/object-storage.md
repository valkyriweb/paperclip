# Shared object storage

Paperclip supports `local_disk` and S3-compatible storage. Local disk remains the default for a single process. It is replica-local and is **not** an active-active storage backend.

## Durable object contract

Shared durable artifacts use immutable keys and a PostgreSQL `durable_objects` row. A writer must complete these steps in order:

1. upload with conditional creation (`If-None-Match: *` on S3);
2. verify the stored byte length and backend SHA-256 when the backend exposes it;
3. commit provider, backend identity, key, SHA-256, byte length, version, ETag, and verification time in PostgreSQL;
4. only then publish an asset, log, or backup reference.

If verification or metadata commit fails, Paperclip removes the newly uploaded version. Reads of committed full objects hash the streamed bytes and mark the row `corrupt` when length or SHA-256 differs. Deletion removes the recorded backend version before marking the metadata `deleted`; failed backend deletion leaves the row committed so retention can retry without losing the object identity.

Tenant objects must use `<company-id>/...` keys. Instance-wide objects use the reserved `system/...` prefix. The backend identity includes the configured S3 endpoint, bucket, and prefix, so equal object keys in separate buckets cannot collide in PostgreSQL.

## Current rollout state

Uploaded assets and issue attachments use this durable contract when the configured provider is shared. Completed run-log archives use company-scoped `<company-id>/run-logs/...` keys and commit their exact compressed-byte integrity metadata before publishing the `heartbeat_runs` reference.

Database backups created while shared storage is configured are copied to immutable `system/database-backups/...` objects. Paperclip then publishes a separately verified JSON manifest containing the backup key, byte length, SHA-256, and creation time. Restore tooling can materialize the dump from the manifest using only PostgreSQL metadata and shared object storage; it does not require the producing replica's filesystem. This logical dump is the portable secondary recovery tier. Production deployments should use physical base backups plus continuous WAL archiving as the primary, efficient point-in-time-recovery tier; Paperclip does not duplicate that database-native machinery. Local-disk deployments retain their existing single-process behavior.

The following paths are not yet safe for multiple API replicas:

- active run logs are written to replica-local files;
- backup scheduling and shared-object retention do not yet have elected/fenced ownership;
- legacy local objects have no dual-read or copy-forward path;
- workspace and terminal state remain locality-bound.

Do not increase the Paperclip API replica count until those paths and the later ownership/fencing slices are complete and failure-drilled.

## S3 requirements

The configured S3-compatible service must support:

- streaming `PUT` and `GET`;
- `HEAD` with content length;
- conditional `PUT` using `If-None-Match: *`;
- byte ranges;
- SHA-256 checksum fields, where implemented;
- version-specific read/delete when bucket versioning is enabled.

Paperclip records an ETag as backend identity metadata, not as a content checksum. Multipart-upload ETags are not MD5 digests of the complete object.
