/**
 * Seed script — populates the SQLite database with 10 synthetic order scenarios.
 *
 * Scenarios:
 *  ORD-1001  Happy path — fully fulfilled
 *  ORD-1002  Payment captured, fulfillment never started       → fulfillment_failure
 *  ORD-1003  Payment captured, inventory unavailable           → fulfillment_failure
 *  ORD-1004  Payment status mismatch (internal ≠ provider)     → payment_mismatch
 *  ORD-1005  Order stuck in processing > 6 hours              → stuck_processing
 *  ORD-1006  Fulfillment failed mid-way (provider timeout)    → fulfillment_failure
 *  ORD-1007  Duplicate fulfillment event detected             → stuck_processing
 *  ORD-1008  Fulfillment in processing > 3 hours              → fulfillment_delay
 *  ORD-1009  Payment never captured (still pending)           → payment_mismatch
 *  ORD-1010  Previously failed, successfully retried          → resolved
 *
 * Run with: pnpm seed
 */

import "dotenv/config";
import { db } from "./client.js";
import {
  orders,
  payments,
  fulfillment,
  orderEvents,
  auditLog,
} from "./schema.js";

const now = new Date();

function hoursAgo(h: number): string {
  return new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();
}

function minutesAgo(m: number): string {
  return new Date(now.getTime() - m * 60 * 1000).toISOString();
}

async function seed(): Promise<void> {
  console.log("🌱 Seeding database...");

  // Clear existing data in dependency order
  await db.delete(auditLog);
  await db.delete(orderEvents);
  await db.delete(fulfillment);
  await db.delete(payments);
  await db.delete(orders);

  // ORD-1001 — Happy path
  await db.insert(orders).values({
    id: "ORD-1001",
    status: "fulfilled",
    customerEmail: "alice@example.com",
    amount: 2500.0,
    currency: "INR",
    items: JSON.stringify([
      { sku: "SKU-001", name: "Wireless Headphones", quantity: 1 },
    ]),
    createdAt: hoursAgo(48),
    updatedAt: hoursAgo(46),
  });
  await db.insert(payments).values({
    id: "PAY-1001",
    orderId: "ORD-1001",
    internalStatus: "captured",
    providerStatus: "captured",
    amount: 2500.0,
    currency: "INR",
    capturedAt: hoursAgo(47),
  });
  await db.insert(fulfillment).values({
    id: "FUL-1001",
    orderId: "ORD-1001",
    status: "delivered",
    startedAt: hoursAgo(46),
    updatedAt: hoursAgo(24),
  });
  await db.insert(orderEvents).values([
    {
      id: "EVT-1001-1",
      orderId: "ORD-1001",
      eventType: "order_created",
      description: "Order placed for INR 2,500",
      createdAt: hoursAgo(48),
    },
    {
      id: "EVT-1001-2",
      orderId: "ORD-1001",
      eventType: "payment_captured",
      description: "Payment of INR 2,500 captured successfully",
      createdAt: hoursAgo(47),
    },
    {
      id: "EVT-1001-3",
      orderId: "ORD-1001",
      eventType: "inventory_reserved",
      description: "1x Wireless Headphones reserved",
      createdAt: hoursAgo(47),
    },
    {
      id: "EVT-1001-4",
      orderId: "ORD-1001",
      eventType: "fulfillment_started",
      description: "Fulfillment processing initiated",
      createdAt: hoursAgo(46),
    },
    {
      id: "EVT-1001-5",
      orderId: "ORD-1001",
      eventType: "order_shipped",
      description: "Order dispatched via BlueDart",
      createdAt: hoursAgo(44),
    },
    {
      id: "EVT-1001-6",
      orderId: "ORD-1001",
      eventType: "order_delivered",
      description: "Order delivered to customer",
      createdAt: hoursAgo(24),
    },
  ]);

  // ORD-1002 — Fulfillment never started
  await db.insert(orders).values({
    id: "ORD-1002",
    status: "processing",
    customerEmail: "bob@example.com",
    amount: 4200.0,
    currency: "INR",
    items: JSON.stringify([
      { sku: "SKU-042", name: "Smart Watch", quantity: 1 },
    ]),
    createdAt: hoursAgo(6),
    updatedAt: hoursAgo(5),
  });
  await db.insert(payments).values({
    id: "PAY-1002",
    orderId: "ORD-1002",
    internalStatus: "captured",
    providerStatus: "captured",
    amount: 4200.0,
    currency: "INR",
    capturedAt: hoursAgo(5),
  });
  await db.insert(fulfillment).values({
    id: "FUL-1002",
    orderId: "ORD-1002",
    status: "not_started",
    updatedAt: hoursAgo(5),
  });
  await db.insert(orderEvents).values([
    {
      id: "EVT-1002-1",
      orderId: "ORD-1002",
      eventType: "order_created",
      description: "Order placed for INR 4,200",
      createdAt: hoursAgo(6),
    },
    {
      id: "EVT-1002-2",
      orderId: "ORD-1002",
      eventType: "payment_captured",
      description: "Payment of INR 4,200 captured successfully",
      createdAt: hoursAgo(5),
    },
    {
      id: "EVT-1002-3",
      orderId: "ORD-1002",
      eventType: "inventory_reserved",
      description: "1x Smart Watch reserved in warehouse",
      createdAt: hoursAgo(5),
    },
  ]);

  // ORD-1003 — Inventory unavailable
  await db.insert(orders).values({
    id: "ORD-1003",
    status: "processing",
    customerEmail: "carol@example.com",
    amount: 1800.0,
    currency: "INR",
    items: JSON.stringify([
      { sku: "SKU-4421", name: "Gaming Keyboard", quantity: 2 },
    ]),
    createdAt: hoursAgo(8),
    updatedAt: hoursAgo(7),
  });
  await db.insert(payments).values({
    id: "PAY-1003",
    orderId: "ORD-1003",
    internalStatus: "captured",
    providerStatus: "captured",
    amount: 1800.0,
    currency: "INR",
    capturedAt: hoursAgo(7),
  });
  await db.insert(fulfillment).values({
    id: "FUL-1003",
    orderId: "ORD-1003",
    status: "failed",
    failureReason: "Inventory unavailable for SKU-4421 — out of stock",
    updatedAt: hoursAgo(7),
  });
  await db.insert(orderEvents).values([
    {
      id: "EVT-1003-1",
      orderId: "ORD-1003",
      eventType: "order_created",
      description: "Order placed for INR 1,800",
      createdAt: hoursAgo(8),
    },
    {
      id: "EVT-1003-2",
      orderId: "ORD-1003",
      eventType: "payment_captured",
      description: "Payment of INR 1,800 captured",
      createdAt: hoursAgo(7),
    },
    {
      id: "EVT-1003-3",
      orderId: "ORD-1003",
      eventType: "fulfillment_failed",
      description: "Fulfillment failed: inventory unavailable for SKU-4421",
      createdAt: hoursAgo(7),
    },
  ]);

  // ORD-1004 — Payment status mismatch
  await db.insert(orders).values({
    id: "ORD-1004",
    status: "processing",
    customerEmail: "david@example.com",
    amount: 6500.0,
    currency: "INR",
    items: JSON.stringify([
      { sku: "SKU-099", name: "4K Monitor", quantity: 1 },
    ]),
    createdAt: hoursAgo(3),
    updatedAt: hoursAgo(3),
  });
  await db.insert(payments).values({
    id: "PAY-1004",
    orderId: "ORD-1004",
    internalStatus: "captured", // internal says captured
    providerStatus: "failed", // provider says failed — MISMATCH
    amount: 6500.0,
    currency: "INR",
    capturedAt: hoursAgo(3),
  });
  await db.insert(fulfillment).values({
    id: "FUL-1004",
    orderId: "ORD-1004",
    status: "not_started",
    updatedAt: hoursAgo(3),
  });
  await db.insert(orderEvents).values([
    {
      id: "EVT-1004-1",
      orderId: "ORD-1004",
      eventType: "order_created",
      description: "Order placed for INR 6,500",
      createdAt: hoursAgo(3),
    },
    {
      id: "EVT-1004-2",
      orderId: "ORD-1004",
      eventType: "payment_initiated",
      description: "Payment gateway initiated for INR 6,500",
      createdAt: hoursAgo(3),
    },
    {
      id: "EVT-1004-3",
      orderId: "ORD-1004",
      eventType: "payment_status_mismatch",
      description:
        "Internal: captured | Provider: failed — manual review required",
      createdAt: hoursAgo(3),
      metadata: JSON.stringify({
        internalStatus: "captured",
        providerStatus: "failed",
      }),
    },
  ]);

  // ORD-1005 — Stuck in processing > 6 hours
  await db.insert(orders).values({
    id: "ORD-1005",
    status: "stuck",
    customerEmail: "eve@example.com",
    amount: 950.0,
    currency: "INR",
    items: JSON.stringify([
      { sku: "SKU-215", name: "Bluetooth Speaker", quantity: 1 },
    ]),
    createdAt: hoursAgo(8),
    updatedAt: hoursAgo(6),
    stuckSince: hoursAgo(6),
  });
  await db.insert(payments).values({
    id: "PAY-1005",
    orderId: "ORD-1005",
    internalStatus: "captured",
    providerStatus: "captured",
    amount: 950.0,
    currency: "INR",
    capturedAt: hoursAgo(7),
  });
  await db.insert(fulfillment).values({
    id: "FUL-1005",
    orderId: "ORD-1005",
    status: "processing",
    startedAt: hoursAgo(6),
    updatedAt: hoursAgo(6),
  });
  await db.insert(orderEvents).values([
    {
      id: "EVT-1005-1",
      orderId: "ORD-1005",
      eventType: "order_created",
      description: "Order placed for INR 950",
      createdAt: hoursAgo(8),
    },
    {
      id: "EVT-1005-2",
      orderId: "ORD-1005",
      eventType: "payment_captured",
      description: "Payment of INR 950 captured",
      createdAt: hoursAgo(7),
    },
    {
      id: "EVT-1005-3",
      orderId: "ORD-1005",
      eventType: "fulfillment_started",
      description: "Fulfillment initiated with provider",
      createdAt: hoursAgo(6),
    },
    {
      id: "EVT-1005-4",
      orderId: "ORD-1005",
      eventType: "order_stuck",
      description: "No fulfillment progress detected — order marked as stuck",
      createdAt: hoursAgo(4),
    },
  ]);

  // ORD-1006 — Fulfillment failed mid-way (provider timeout)
  await db.insert(orders).values({
    id: "ORD-1006",
    status: "processing",
    customerEmail: "frank@example.com",
    amount: 3300.0,
    currency: "INR",
    items: JSON.stringify([
      { sku: "SKU-330", name: "Office Chair", quantity: 1 },
    ]),
    createdAt: hoursAgo(5),
    updatedAt: hoursAgo(4),
  });
  await db.insert(payments).values({
    id: "PAY-1006",
    orderId: "ORD-1006",
    internalStatus: "captured",
    providerStatus: "captured",
    amount: 3300.0,
    currency: "INR",
    capturedAt: hoursAgo(4),
  });
  await db.insert(fulfillment).values({
    id: "FUL-1006",
    orderId: "ORD-1006",
    status: "failed",
    failureReason:
      "Delivery partner API timeout after 3 retries — provider unreachable",
    startedAt: hoursAgo(4),
    updatedAt: hoursAgo(4),
  });
  await db.insert(orderEvents).values([
    {
      id: "EVT-1006-1",
      orderId: "ORD-1006",
      eventType: "order_created",
      description: "Order placed for INR 3,300",
      createdAt: hoursAgo(5),
    },
    {
      id: "EVT-1006-2",
      orderId: "ORD-1006",
      eventType: "payment_captured",
      description: "Payment of INR 3,300 captured",
      createdAt: hoursAgo(4),
    },
    {
      id: "EVT-1006-3",
      orderId: "ORD-1006",
      eventType: "fulfillment_started",
      description: "Fulfillment initiated",
      createdAt: hoursAgo(4),
    },
    {
      id: "EVT-1006-4",
      orderId: "ORD-1006",
      eventType: "fulfillment_failed",
      description: "Provider API timeout after 3 retries",
      createdAt: minutesAgo(210),
    },
  ]);

  // ORD-1007 — Duplicate processing event
  await db.insert(orders).values({
    id: "ORD-1007",
    status: "stuck",
    customerEmail: "grace@example.com",
    amount: 750.0,
    currency: "INR",
    items: JSON.stringify([{ sku: "SKU-007", name: "USB-C Hub", quantity: 3 }]),
    createdAt: hoursAgo(5),
    updatedAt: hoursAgo(2),
    stuckSince: hoursAgo(2),
  });
  await db.insert(payments).values({
    id: "PAY-1007",
    orderId: "ORD-1007",
    internalStatus: "captured",
    providerStatus: "captured",
    amount: 750.0,
    currency: "INR",
    capturedAt: hoursAgo(4),
  });
  await db.insert(fulfillment).values({
    id: "FUL-1007",
    orderId: "ORD-1007",
    status: "processing",
    startedAt: hoursAgo(3),
    updatedAt: hoursAgo(2),
  });
  await db.insert(orderEvents).values([
    {
      id: "EVT-1007-1",
      orderId: "ORD-1007",
      eventType: "order_created",
      description: "Order placed for INR 750",
      createdAt: hoursAgo(5),
    },
    {
      id: "EVT-1007-2",
      orderId: "ORD-1007",
      eventType: "payment_captured",
      description: "Payment captured",
      createdAt: hoursAgo(4),
    },
    {
      id: "EVT-1007-3",
      orderId: "ORD-1007",
      eventType: "fulfillment_started",
      description: "Fulfillment initiated",
      createdAt: hoursAgo(3),
    },
    {
      id: "EVT-1007-4",
      orderId: "ORD-1007",
      eventType: "fulfillment_started",
      description: "Fulfillment initiated (duplicate event detected)",
      createdAt: hoursAgo(3),
      metadata: JSON.stringify({ duplicate: true }),
    },
    {
      id: "EVT-1007-5",
      orderId: "ORD-1007",
      eventType: "order_stuck",
      description: "Duplicate fulfillment events caused processing deadlock",
      createdAt: hoursAgo(2),
    },
  ]);

  // ORD-1008 — Fulfillment delayed (processing > 3 hours)
  await db.insert(orders).values({
    id: "ORD-1008",
    status: "processing",
    customerEmail: "henry@example.com",
    amount: 2100.0,
    currency: "INR",
    items: JSON.stringify([
      { sku: "SKU-801", name: "Mechanical Keyboard", quantity: 1 },
    ]),
    createdAt: hoursAgo(4),
    updatedAt: hoursAgo(3),
  });
  await db.insert(payments).values({
    id: "PAY-1008",
    orderId: "ORD-1008",
    internalStatus: "captured",
    providerStatus: "captured",
    amount: 2100.0,
    currency: "INR",
    capturedAt: hoursAgo(3),
  });
  await db.insert(fulfillment).values({
    id: "FUL-1008",
    orderId: "ORD-1008",
    status: "processing",
    startedAt: hoursAgo(3),
    updatedAt: hoursAgo(3), // No update in 3 hours — delayed
  });
  await db.insert(orderEvents).values([
    {
      id: "EVT-1008-1",
      orderId: "ORD-1008",
      eventType: "order_created",
      description: "Order placed for INR 2,100",
      createdAt: hoursAgo(4),
    },
    {
      id: "EVT-1008-2",
      orderId: "ORD-1008",
      eventType: "payment_captured",
      description: "Payment of INR 2,100 captured",
      createdAt: hoursAgo(3),
    },
    {
      id: "EVT-1008-3",
      orderId: "ORD-1008",
      eventType: "fulfillment_started",
      description: "Fulfilment handed to delivery partner",
      createdAt: hoursAgo(3),
    },
  ]);

  // ORD-1009 — Payment never captured (still pending)
  await db.insert(orders).values({
    id: "ORD-1009",
    status: "pending",
    customerEmail: "iris@example.com",
    amount: 5500.0,
    currency: "INR",
    items: JSON.stringify([
      { sku: "SKU-990", name: "Standing Desk", quantity: 1 },
    ]),
    createdAt: hoursAgo(2),
    updatedAt: hoursAgo(2),
  });
  await db.insert(payments).values({
    id: "PAY-1009",
    orderId: "ORD-1009",
    internalStatus: "pending",
    providerStatus: "pending",
    amount: 5500.0,
    currency: "INR",
  });
  await db.insert(fulfillment).values({
    id: "FUL-1009",
    orderId: "ORD-1009",
    status: "not_started",
    updatedAt: hoursAgo(2),
  });
  await db.insert(orderEvents).values([
    {
      id: "EVT-1009-1",
      orderId: "ORD-1009",
      eventType: "order_created",
      description: "Order placed for INR 5,500",
      createdAt: hoursAgo(2),
    },
    {
      id: "EVT-1009-2",
      orderId: "ORD-1009",
      eventType: "payment_initiated",
      description: "Payment gateway session created",
      createdAt: hoursAgo(2),
    },
  ]);

  // ORD-1010 — Previously failed, successfully retried
  await db.insert(orders).values({
    id: "ORD-1010",
    status: "fulfilled",
    customerEmail: "james@example.com",
    amount: 890.0,
    currency: "INR",
    items: JSON.stringify([
      { sku: "SKU-100", name: "Laptop Stand", quantity: 1 },
    ]),
    createdAt: hoursAgo(12),
    updatedAt: hoursAgo(10),
  });
  await db.insert(payments).values({
    id: "PAY-1010",
    orderId: "ORD-1010",
    internalStatus: "captured",
    providerStatus: "captured",
    amount: 890.0,
    currency: "INR",
    capturedAt: hoursAgo(11),
  });
  await db.insert(fulfillment).values({
    id: "FUL-1010",
    orderId: "ORD-1010",
    status: "shipped",
    startedAt: hoursAgo(10),
    updatedAt: hoursAgo(10),
  });
  await db.insert(orderEvents).values([
    {
      id: "EVT-1010-1",
      orderId: "ORD-1010",
      eventType: "order_created",
      description: "Order placed for INR 890",
      createdAt: hoursAgo(12),
    },
    {
      id: "EVT-1010-2",
      orderId: "ORD-1010",
      eventType: "payment_captured",
      description: "Payment captured",
      createdAt: hoursAgo(11),
    },
    {
      id: "EVT-1010-3",
      orderId: "ORD-1010",
      eventType: "fulfillment_started",
      description: "First fulfillment attempt",
      createdAt: hoursAgo(11),
    },
    {
      id: "EVT-1010-4",
      orderId: "ORD-1010",
      eventType: "fulfillment_failed",
      description: "Initial attempt failed — provider queue full",
      createdAt: minutesAgo(630),
    },
    {
      id: "EVT-1010-5",
      orderId: "ORD-1010",
      eventType: "fulfillment_retried",
      description: "Fulfillment retried by operations team",
      createdAt: hoursAgo(10),
    },
    {
      id: "EVT-1010-6",
      orderId: "ORD-1010",
      eventType: "order_shipped",
      description: "Order dispatched successfully",
      createdAt: hoursAgo(10),
    },
  ]);
  await db.insert(auditLog).values({
    id: "AUD-1010-1",
    orderId: "ORD-1010",
    action: "retry_fulfillment",
    reason: "Initial provider attempt failed due to queue overflow",
    outcome: "Fulfillment succeeded on retry — order shipped",
    performedAt: hoursAgo(10),
  });

  console.log("Seeded 10 orders successfully.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
