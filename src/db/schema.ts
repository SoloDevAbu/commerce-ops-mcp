import { pgTable, text, doublePrecision } from "drizzle-orm/pg-core";

// Order status flow:
// pending → processing → fulfilled | cancelled
// Any order in processing > 4 hours is considered stuck

export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  // pending | processing | stuck | fulfilled | cancelled
  customerEmail: text("customer_email").notNull(),
  amount: doublePrecision("amount").notNull(),
  currency: text("currency").notNull().default("INR"),
  // JSON string: [{sku, name, quantity}]
  items: text("items").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // Set when an order transitions into a stuck state
  stuckSince: text("stuck_since"),
});

export const payments = pgTable("payments", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .unique()
    .references(() => orders.id),
  // What our internal system recorded
  internalStatus: text("internal_status").notNull(),
  // pending | captured | failed | refunded
  // What the synthetic payment provider actually shows.
  // These can differ — that divergence is the payment_mismatch scenario.
  providerStatus: text("provider_status").notNull(),
  amount: doublePrecision("amount").notNull(),
  currency: text("currency").notNull().default("INR"),
  capturedAt: text("captured_at"),
});

export const fulfillment = pgTable("fulfillment", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .unique()
    .references(() => orders.id),
  status: text("status").notNull(),
  // not_started | processing | failed | shipped | delivered
  failureReason: text("failure_reason"),
  startedAt: text("started_at"),
  updatedAt: text("updated_at").notNull(),
});

// Append-only event log — the source of truth for the investigation timeline.
// Every meaningful state change writes an event here.
export const orderEvents = pgTable("order_events", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id),
  eventType: text("event_type").notNull(),
  description: text("description").notNull(),
  // Optional JSON metadata for the event
  metadata: text("metadata"),
  createdAt: text("created_at").notNull(),
});

// Written by every state-changing MCP tool call.
// Provides an audit trail for operational actions taken through the MCP.
export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  outcome: text("outcome").notNull(),
  performedAt: text("performed_at").notNull(),
});
