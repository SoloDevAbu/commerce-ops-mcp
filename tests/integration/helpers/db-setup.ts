/**
 * Integration test database helper.
 *
 * Uses the same Neon PostgreSQL instance (DATABASE_URL).
 * Cleans all tables between tests to prevent interference.
 *
 * Usage in tests:
 *   import { cleanTables, seedTestOrder } from "./helpers/db-setup.js";
 *   beforeEach(() => cleanTables());
 */

import { randomUUID } from "node:crypto";
import { db } from "../../../src/db/client.js";
import {
  orders,
  payments,
  fulfillment,
  orderEvents,
  auditLog,
} from "../../../src/db/schema.js";
import { eq, sql } from "drizzle-orm";

/** Truncates all tables in one shot — CASCADE handles FK ordering automatically */
export async function cleanTables(): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE audit_log, order_events, fulfillment, payments, orders CASCADE`,
  );
}

/** Creates a test order with related records and returns the internal UUID */
export async function seedTestOrder(opts: {
  orderId: string;
  status: string;
  paymentStatus?: string;
  fulfillmentStatus?: string;
  fulfillmentFailureReason?: string;
}): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const hoursAgo = (h: number) =>
    new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

  await db.insert(orders).values({
    id,
    orderId: opts.orderId,
    status: opts.status,
    customerEmail: "test@example.com",
    amount: 1000,
    currency: "INR",
    items: JSON.stringify([{ sku: "TEST-SKU", name: "Test Item", quantity: 1 }]),
    createdAt: hoursAgo(6),
    updatedAt: hoursAgo(5),
    stuckSince: opts.status === "stuck" ? hoursAgo(4) : null,
  });

  if (opts.paymentStatus) {
    await db.insert(payments).values({
      id: randomUUID(),
      orderId: id,
      internalStatus: opts.paymentStatus,
      providerStatus: opts.paymentStatus,
      amount: 1000,
      currency: "INR",
      capturedAt: opts.paymentStatus === "captured" ? hoursAgo(5) : null,
    });
  }

  if (opts.fulfillmentStatus) {
    await db.insert(fulfillment).values({
      id: randomUUID(),
      orderId: id,
      status: opts.fulfillmentStatus,
      failureReason: opts.fulfillmentFailureReason ?? null,
      startedAt: opts.fulfillmentStatus !== "not_started" ? hoursAgo(4) : null,
      updatedAt: hoursAgo(4),
    });
  }

  return id;
}

/** Read helpers for assertions */
export async function getOrder(orderId: string) {
  const rows = await db
    .select()
    .from(orders)
    .where(eq(orders.orderId, orderId));
  return rows[0] ?? null;
}

export async function getAuditLogs(internalOrderId: string) {
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.orderId, internalOrderId));
}

export async function getOrderEvents(internalOrderId: string) {
  return db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, internalOrderId));
}

export async function getFulfillment(internalOrderId: string) {
  const rows = await db
    .select()
    .from(fulfillment)
    .where(eq(fulfillment.orderId, internalOrderId));
  return rows[0] ?? null;
}
