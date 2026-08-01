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
 *
 * ID strategy:
 *  - Accepts human-readable orderId (e.g. "ORD-1047") from MCP tools
 *  - Resolves to internal UUID via orders.order_id lookup
 *  - Uses UUID for all DB writes and FK references
 *  - Returns human-readable orderId in all result objects
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
  ApprovalRequiredError,
  type RetryResult,
  type StatusUpdateResult,
} from "../types.js";
import { VALID_TRANSITIONS } from "../constants.js";

/**
 * Checks if an error is a PostgreSQL unique constraint violation (code 23505).
 * Used to gracefully handle concurrent duplicate operations via idempotency keys.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code: string }).code === "23505"
  );
}

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
  confirmed: boolean,
): Promise<RetryResult> {
  const now = new Date().toISOString();

  // Step 1: Read order outside tx for early validation / preview mode
  const orderRows = await db
    .select()
    .from(orders)
    .where(eq(orders.orderId, orderId));

  const order = orderRows[0];
  if (!order) throw new OrderNotFoundError(orderId);

  // Step 2: Fetch related records for preview validation
  const internalId = order.id;
  const [paymentRows, fulfillmentRows] = await Promise.all([
    db.select().from(payments).where(eq(payments.orderId, internalId)),
    db.select().from(fulfillment).where(eq(fulfillment.orderId, internalId)),
  ]);

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

  // Approval gate — server-side enforcement.
  // All eligibility guards have already run, so this preview is accurate.
  if (!confirmed) {
    return {
      confirmed: false,
      orderId: order.orderId,
      validationPassed: true,
      message:
        `Validation passed for ${order.orderId}. ` +
        `Order is eligible for fulfillment retry. ` +
        `Set confirmed=true to execute.`,
    };
  }

  // Execute recovery inside a transaction with row lock to prevent concurrent mutations.
  const idempotencyKey = `retry_fulfillment:${orderId}`;

  try {
    await db.transaction(async (tx) => {
      // Re-read order with FOR UPDATE lock — prevents concurrent retries
      const [lockedOrder] = await tx
        .select()
        .from(orders)
        .where(eq(orders.orderId, orderId))
        .for("update");

      if (!lockedOrder) throw new OrderNotFoundError(orderId);

      // Re-validate inside the lock — state may have changed since preview
      if (!RETRYABLE_ORDER_STATUSES.has(lockedOrder.status)) {
        throw new InvalidStateError(
          `Order ${orderId} is no longer in a retryable state (current: "${lockedOrder.status}"). ` +
            `Another operation may have already processed this order.`,
        );
      }

      // Re-fetch fulfillment inside tx
      const [lockedFul] = await tx
        .select()
        .from(fulfillment)
        .where(eq(fulfillment.orderId, lockedOrder.id));

      if (lockedFul) {
        await tx
          .update(fulfillment)
          .set({
            status: "processing",
            failureReason: null,
            startedAt: now,
            updatedAt: now,
          })
          .where(eq(fulfillment.orderId, lockedOrder.id));
      } else {
        await tx.insert(fulfillment).values({
          id: randomUUID(),
          orderId: lockedOrder.id,
          status: "processing",
          startedAt: now,
          updatedAt: now,
        });
      }

      await tx
        .update(orders)
        .set({ status: "processing", updatedAt: now, stuckSince: null })
        .where(eq(orders.id, lockedOrder.id));

      await tx.insert(orderEvents).values({
        id: randomUUID(),
        orderId: lockedOrder.id,
        eventType: "fulfillment_retried",
        description: `Fulfillment retried by operations. Reason: ${reason}`,
        createdAt: now,
      });

      await writeAudit(
        {
          orderId: lockedOrder.id,
          action: "retry_fulfillment",
          reason,
          outcome: "Fulfillment restarted — status set to processing",
          idempotencyKey,
        },
        tx,
      );
    });
  } catch (error: unknown) {
    // Gracefully handle concurrent duplicate retries via idempotency key
    if (isUniqueViolation(error)) {
      return {
        confirmed: true,
        success: true,
        orderId: order.orderId,
        message: `Fulfillment retry for ${order.orderId} was already processed.`,
        newStatus: "processing",
        auditId: "(already recorded)",
      };
    }
    throw error;
  }

  return {
    confirmed: true,
    success: true,
    orderId: order.orderId, // human-readable in response
    message:
      `Fulfillment processing has been restarted for ${order.orderId}. ` +
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
  confirmed: boolean = false,
): Promise<StatusUpdateResult> {
  // Step 1: Resolve human-readable orderId → internal UUID
  const orderRows = await db
    .select()
    .from(orders)
    .where(eq(orders.orderId, orderId));

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

  // Enforce strict transition rules
  const allowedNext = VALID_TRANSITIONS[order.status];
  if (!allowedNext || !allowedNext.includes(newStatus)) {
    throw new InvalidStateError(
      `Cannot transition order ${orderId} from "${order.status}" to "${newStatus}". ` +
        `Valid transitions from "${order.status}": ${
          allowedNext?.length ? allowedNext.join(", ") : "none (terminal state)"
        }.`,
    );
  }

  const riskLevel = assessRisk(order.status, newStatus);
  const impact = describeImpact(order.status, newStatus);

  // Dry-run: return preview without making changes
  if (dryRun) {
    return {
      dryRun: true,
      orderId: order.orderId, // human-readable
      currentStatus: order.status,
      proposedStatus: newStatus,
      impact,
      riskLevel,
    };
  }

  // Server-side approval gate — must be explicitly confirmed even when dryRun=false
  if (!confirmed) {
    throw new ApprovalRequiredError();
  }

  // Execute update inside a transaction with row lock to prevent concurrent mutations.
  const now = new Date().toISOString();
  const previousStatus = order.status;
  const idempotencyKey = `update_status:${orderId}:${previousStatus}:${newStatus}`;

  try {
    await db.transaction(async (tx) => {
      // Re-read with row lock — prevents concurrent updates
      const [lockedOrder] = await tx
        .select()
        .from(orders)
        .where(eq(orders.orderId, orderId))
        .for("update");

      if (!lockedOrder) throw new OrderNotFoundError(orderId);

      // Re-validate — status may have changed since preview
      if (lockedOrder.status !== previousStatus) {
        throw new InvalidStateError(
          `Order ${orderId} status changed to "${lockedOrder.status}" since preview. ` +
            `Please re-run with dryRun=true to get an updated preview.`,
        );
      }

      await tx
        .update(orders)
        .set({
          status: newStatus,
          updatedAt: now,
          stuckSince: newStatus === "stuck" ? now : null,
        })
        .where(eq(orders.id, lockedOrder.id));

      await tx.insert(orderEvents).values({
        id: randomUUID(),
        orderId: lockedOrder.id,
        eventType: "status_updated",
        description: `Status manually updated: "${previousStatus}" → "${newStatus}". Reason: ${reason}`,
        createdAt: now,
      });

      await writeAudit(
        {
          orderId: lockedOrder.id,
          action: "update_order_status",
          reason,
          outcome: `Status changed from "${previousStatus}" to "${newStatus}"`,
          idempotencyKey,
        },
        tx,
      );
    });
  } catch (error: unknown) {
    // Gracefully handle concurrent duplicate updates via idempotency key
    if (isUniqueViolation(error)) {
      return {
        dryRun: false,
        success: true,
        orderId: order.orderId,
        previousStatus,
        newStatus,
        auditId: "(already recorded)",
      };
    }
    throw error;
  }

  return {
    dryRun: false,
    success: true,
    orderId: order.orderId, // human-readable in response
    previousStatus,
    newStatus,
    auditId: "(see audit_log)",
  };
}
