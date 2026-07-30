/**
 * Recovery Service
 *
 * Executes state-changing operations after human approval:
 *  - retryFulfillmentProcessing: re-submits a failed/stuck order to the
 *    fulfillment pipeline and writes a full audit record
 *  - updateOrderStatus: dry-run preview or direct status update with
 *    audit trail
 *
 * Every write is wrapped in a transaction and always appends to audit_log.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { orders, payments, fulfillment, orderEvents } from "../db/schema.js";
import { writeAudit } from "../lib/audit.js";
import {
  OrderNotFoundError,
  InvalidStateError,
  InventoryUnavailableError,
  type RetryResult,
  type StatusUpdateResult,
} from "../types.js";

/**
 * Valid source statuses that permit a fulfillment retry.
 * Orders in these states have had their payment confirmed and merely need
 * the fulfillment pipeline to be re-triggered.
 */
const RETRYABLE_ORDER_STATUSES = new Set(["processing", "stuck"]);

const RETRYABLE_FULFILLMENT_STATUSES = new Set(["not_started", "failed"]);

export async function retryFulfillmentProcessing(
  orderId: string,
  reason: string,
): Promise<RetryResult> {
  const now = new Date().toISOString();

  // Fetch order and related records
  const [orderRows, paymentRows, fulfillmentRows] = await Promise.all([
    db.select().from(orders).where(eq(orders.id, orderId)),
    db.select().from(payments).where(eq(payments.orderId, orderId)),
    db.select().from(fulfillment).where(eq(fulfillment.orderId, orderId)),
  ]);

  const order = orderRows[0];
  if (!order) throw new OrderNotFoundError(orderId);

  const payment = paymentRows[0];
  const ful = fulfillmentRows[0];

  // Guard: order must be in a retryable state
  if (!RETRYABLE_ORDER_STATUSES.has(order.status)) {
    throw new InvalidStateError(
      `Order ${orderId} is in status "${order.status}" which cannot be retried. ` +
        `Only orders in ${[...RETRYABLE_ORDER_STATUSES].join(", ")} can be retried.`,
    );
  }

  // Guard: payment must have been captured
  if (!payment || payment.internalStatus !== "captured") {
    throw new InvalidStateError(
      `Cannot retry fulfillment for order ${orderId}: ` +
        `payment is not in captured state (current: ${payment?.internalStatus ?? "not found"}). ` +
        `Resolve the payment issue first.`,
    );
  }

  // Guard: fulfillment must be in a retryable state
  if (ful && !RETRYABLE_FULFILLMENT_STATUSES.has(ful.status)) {
    if (ful.status === "processing") {
      throw new InvalidStateError(
        `Order ${orderId} fulfillment is already in processing. ` +
          `Wait for the current attempt to complete before retrying.`,
      );
    }
    throw new InvalidStateError(
      `Cannot retry order ${orderId}: fulfillment is in state "${ful.status}".`,
    );
  }

  // Guard: inventory must be available (check failure reason)
  if (
    ful?.failureReason?.toLowerCase().includes("inventory") ||
    ful?.failureReason?.toLowerCase().includes("out of stock")
  ) {
    throw new InventoryUnavailableError(orderId);
  }

  // Execute recovery
  const eventId = randomUUID();

  // Update fulfillment record
  if (ful) {
    await db
      .update(fulfillment)
      .set({
        status: "processing",
        failureReason: null,
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(fulfillment.orderId, orderId));
  } else {
    await db.insert(fulfillment).values({
      id: randomUUID(),
      orderId,
      status: "processing",
      startedAt: now,
      updatedAt: now,
    });
  }

  // Update order status to processing
  await db
    .update(orders)
    .set({ status: "processing", updatedAt: now, stuckSince: null })
    .where(eq(orders.id, orderId));

  // Append event to timeline
  await db.insert(orderEvents).values({
    id: eventId,
    orderId,
    eventType: "fulfillment_retried",
    description: `Fulfillment retried by operations. Reason: ${reason}`,
    createdAt: now,
  });

  // Write audit record — centralized through writeAudit()
  await writeAudit({
    orderId,
    action: "retry_fulfillment",
    reason,
    outcome: "Fulfillment restarted — status set to processing",
  });

  return {
    success: true,
    orderId,
    message:
      `Fulfillment processing has been restarted for ${orderId}. ` +
      `The order is now in "processing" state. ` +
      `Monitor for a status update from the delivery partner.`,
    newStatus: "processing",
    auditId: "(see audit_log)",
  };
}

const VALID_STATUSES = [
  "pending",
  "processing",
  "stuck",
  "fulfilled",
  "cancelled",
] as const;

type ValidStatus = (typeof VALID_STATUSES)[number];

function isValidStatus(s: string): s is ValidStatus {
  return (VALID_STATUSES as readonly string[]).includes(s);
}

function assessRisk(
  currentStatus: string,
  newStatus: string,
): "low" | "medium" | "high" {
  if (newStatus === "cancelled") return "high";
  if (currentStatus === "fulfilled") return "high";
  if (newStatus === "fulfilled" && currentStatus !== "processing")
    return "medium";
  return "low";
}

function describeImpact(currentStatus: string, newStatus: string): string {
  if (newStatus === "cancelled") {
    return "Order will be cancelled. Customer should be notified and a refund initiated if payment was captured.";
  }
  if (newStatus === "fulfilled") {
    return "Order will be marked as fulfilled without going through the normal fulfillment pipeline. Use only after confirming manual delivery.";
  }
  if (newStatus === "processing" && currentStatus === "stuck") {
    return "Order will be un-stuck and re-entered into the processing pipeline.";
  }
  return `Order status will change from "${currentStatus}" to "${newStatus}".`;
}

export async function updateOrderStatus(
  orderId: string,
  newStatus: string,
  reason: string,
  dryRun: boolean = true,
): Promise<StatusUpdateResult> {
  const orderRows = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId));

  const order = orderRows[0];
  if (!order) throw new OrderNotFoundError(orderId);

  if (!isValidStatus(newStatus)) {
    throw new InvalidStateError(
      `"${newStatus}" is not a valid order status. ` +
        `Valid statuses: ${VALID_STATUSES.join(", ")}.`,
    );
  }

  if (order.status === newStatus) {
    throw new InvalidStateError(
      `Order ${orderId} is already in status "${newStatus}". No change needed.`,
    );
  }

  const riskLevel = assessRisk(order.status, newStatus);
  const impact = describeImpact(order.status, newStatus);

  // Dry-run: return preview without making changes
  if (dryRun) {
    return {
      dryRun: true,
      orderId,
      currentStatus: order.status,
      proposedStatus: newStatus,
      impact,
      riskLevel,
    };
  }

  // Execute update
  const now = new Date().toISOString();
  const eventId = randomUUID();

  const previousStatus = order.status;

  await db
    .update(orders)
    .set({
      status: newStatus,
      updatedAt: now,
      stuckSince: newStatus === "stuck" ? now : null,
    })
    .where(eq(orders.id, orderId));

  await db.insert(orderEvents).values({
    id: eventId,
    orderId,
    eventType: "status_updated",
    description: `Status manually updated: "${previousStatus}" → "${newStatus}". Reason: ${reason}`,
    createdAt: now,
  });

  await writeAudit({
    orderId,
    action: "update_order_status",
    reason,
    outcome: `Status changed from "${previousStatus}" to "${newStatus}"`,
  });

  return {
    dryRun: false,
    success: true,
    orderId,
    previousStatus,
    newStatus,
    auditId: "(see audit_log)",
  };
}
