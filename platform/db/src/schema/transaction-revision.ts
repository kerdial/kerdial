import { jsonb, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { appUser } from "./app-user.js";
import { tenant } from "./tenant.js";

export const transactionRevisionKindEnum = pgEnum("transaction_revision_kind", [
  "CREATE",
  "UPDATE",
  "DELETE",
]);

/**
 * `transaction_revision` ("Editing"), the audit trail
 * for FR-13/FR-64's mutable-in-place edit model. Every write to `transaction`
 * (create, edit, delete) appends one row here with a full JSONB before/after
 * snapshot — `transaction_id` deliberately carries **no** foreign key
 * constraint, since a `DELETE`-kind revision's `transaction_id` refers to a
 * row that has just been hard-deleted from `transaction` (the "Deletion"
 * note) and must remain a valid audit reference regardless.
 */
export const transactionRevision = pgTable("transaction_revision", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenant.id),
  transactionId: uuid("transaction_id").notNull(),
  revisionKind: transactionRevisionKindEnum("revision_kind").notNull(),
  before: jsonb("before"), // NULL for a CREATE revision
  after: jsonb("after"), // NULL for a DELETE revision
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  changedBy: uuid("changed_by")
    .notNull()
    .references(() => appUser.id),
});
