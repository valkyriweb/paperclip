import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export type DurableObjectKind = "asset" | "run_log" | "database_backup";
export type DurableObjectStatus = "committed" | "corrupt" | "deleted";

/**
 * Integrity metadata for immutable bytes stored outside PostgreSQL.
 *
 * A durable reference may be published only after its object is uploaded,
 * verified, and this row has been committed. System objects, such as database
 * backups, have no company id and use reserved `system/...` keys.
 */
export const durableObjects = pgTable(
  "durable_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").$type<DurableObjectKind>().notNull(),
    provider: text("provider").notNull(),
    backendId: text("backend_id").notNull(),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    version: text("version"),
    etag: text("etag"),
    status: text("status").$type<DurableObjectStatus>().notNull().default("committed"),
    corruptionReason: text("corruption_reason"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    objectKeyUq: uniqueIndex("durable_objects_object_key_uq").on(table.backendId, table.objectKey),
    companyKindCreatedIdx: index("durable_objects_company_kind_created_idx").on(
      table.companyId,
      table.kind,
      table.createdAt,
    ),
    statusUpdatedIdx: index("durable_objects_status_updated_idx").on(table.status, table.updatedAt),
    kindCheck: check(
      "durable_objects_kind_check",
      sql`${table.kind} in ('asset', 'run_log', 'database_backup')`,
    ),
    statusCheck: check(
      "durable_objects_status_check",
      sql`${table.status} in ('committed', 'corrupt', 'deleted')`,
    ),
    scopeCheck: check(
      "durable_objects_scope_check",
      sql`((${table.companyId} is null and ${table.objectKey} like 'system/%') or (${table.companyId} is not null and ${table.objectKey} like ${table.companyId}::text || '/%'))`,
    ),
    corruptionCheck: check(
      "durable_objects_corruption_check",
      sql`((${table.status} in ('committed', 'deleted') and ${table.corruptionReason} is null) or (${table.status} = 'corrupt' and ${table.corruptionReason} is not null))`,
    ),
    sha256Check: check(
      "durable_objects_sha256_check",
      sql`${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    byteSizeCheck: check("durable_objects_byte_size_check", sql`${table.byteSize} >= 0`),
  }),
);
