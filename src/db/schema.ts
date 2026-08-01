import { pgTable, text, doublePrecision, uuid } from "drizzle-orm/pg-core";

// Order status flow:
// pending => processing => fulfilled | cancelled
// Any order in processing > 4 hours is considered stuck

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: text("order_id").notNull().unique(),
  status: text("status").notNull(),
  customerEmail: text("customer_email").notNull(),
  amount: doublePrecision("amount").notNull(),
  currency: text("currency").notNull().default("INR"),
  items: text("items").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  stuckSince: text("stuck_since"),
});

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .unique()
    .references(() => orders.id),
  internalStatus: text("internal_status").notNull(),
  providerStatus: text("provider_status").notNull(),
  amount: doublePrecision("amount").notNull(),
  currency: text("currency").notNull().default("INR"),
  capturedAt: text("captured_at"),
});

export const fulfillment = pgTable("fulfillment", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .unique()
    .references(() => orders.id),
  status: text("status").notNull(),
  failureReason: text("failure_reason"),
  startedAt: text("started_at"),
  updatedAt: text("updated_at").notNull(),
});

export const orderEvents = pgTable("order_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id),
  eventType: text("event_type").notNull(),
  description: text("description").notNull(),
  metadata: text("metadata"),
  createdAt: text("created_at").notNull(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  outcome: text("outcome").notNull(),
  performedAt: text("performed_at").notNull(),
  idempotencyKey: text("idempotency_key").unique(),
});
