/**
 * Investigation Service
 *
 * The core intelligence layer of the MCP server. Given a human-readable
 * orderId (e.g. "ORD-1047"), this service:
 *  1. Resolves orderId → internal UUID via orders.order_id
 *  2. Correlates data across all five tables (orders, payments, fulfillment,
 *     order_events, audit_log) using the UUID for FK lookups
 *  3. Returns a structured InvestigationReport — not raw data.
 *
 * Design principle: the MCP is the reasoner, not just a data relay.
 */

import { eq, asc } from "drizzle-orm";
import { db } from "../db/client.js";
import { orders, payments, fulfillment, orderEvents } from "../db/schema.js";
import {
  OrderNotFoundError,
  type InvestigationReport,
  type EvidenceItem,
  type TimelineEvent,
} from "../types.js";
import {
  STUCK_THRESHOLD_HOURS,
  FULFILLMENT_DELAY_THRESHOLD_HOURS,
} from "../constants.js";

function hoursSince(isoString: string | null | undefined): number {
  if (!isoString) return 0;
  return (Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60);
}

function hasDuplicateEvents(
  events: TimelineEvent[],
  eventType: string,
): boolean {
  const count = events.filter((e) => e.eventType === eventType).length;
  return count > 1;
}

export async function investigateOrder(
  orderId: string,
): Promise<InvestigationReport> {
  // Step 1: Resolve human-readable orderId → internal UUID
  const orderRows = await db
    .select()
    .from(orders)
    .where(eq(orders.orderId, orderId));

  const order = orderRows[0];
  if (!order) {
    throw new OrderNotFoundError(orderId);
  }

  // Step 2: Use the internal UUID for all FK-based lookups (in parallel)
  const internalId = order.id;
  const [paymentRows, fulfillmentRows, eventRows] = await Promise.all([
    db.select().from(payments).where(eq(payments.orderId, internalId)),
    db.select().from(fulfillment).where(eq(fulfillment.orderId, internalId)),
    db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, internalId))
      .orderBy(asc(orderEvents.createdAt)),
  ]);

  const payment = paymentRows[0];
  const ful = fulfillmentRows[0];

  // Build timeline from event rows
  const timeline: TimelineEvent[] = eventRows.map((e) => ({
    timestamp: e.createdAt,
    eventType: e.eventType,
    description: e.description,
  }));

  // Decision tree
  // All report objects use the human-readable orderId (order.orderId), not the UUID.

  // 1. Payment status mismatch (highest priority — financial risk)
  if (
    payment &&
    payment.internalStatus !== payment.providerStatus &&
    !(
      payment.internalStatus === "pending" &&
      payment.providerStatus === "pending"
    )
  ) {
    const evidence: EvidenceItem[] = [
      {
        label: "Payment Internal Status",
        status: "fail",
        detail: `Internal: ${payment.internalStatus}`,
      },
      {
        label: "Payment Provider Status",
        status: "fail",
        detail: `Provider: ${payment.providerStatus}`,
      },
      {
        label: "Fulfillment Started",
        status: ful?.startedAt ? "pass" : "unknown",
      },
    ];

    return {
      orderId: order.orderId,
      summary:
        `Payment status divergence detected. Internal system recorded "${payment.internalStatus}" ` +
        `but the payment provider reports "${payment.providerStatus}". ` +
        `Fulfillment has been held pending payment resolution.`,
      rootCause:
        "Payment status mismatch between internal records and the payment gateway. " +
        "This requires manual reconciliation to determine the authoritative status.",
      evidence,
      timeline,
      confidence: "high",
      recommendedNextStep:
        "Contact the payment provider to confirm the authoritative transaction status. " +
        "If the provider confirms failure, issue a refund. " +
        "If the provider confirms capture, correct the internal record and retry fulfillment.",
      riskLevel: "high",
      automationEligible: false,
    };
  }

  // 1b. Payment failed — order correctly held, system behaving as expected
  if (
    payment &&
    payment.internalStatus === "failed" &&
    order.status === "pending"
  ) {
    const evidence: EvidenceItem[] = [
      {
        label: "Payment Captured",
        status: "fail",
        detail: `Payment status: ${payment.internalStatus}`,
      },
      {
        label: "Fulfillment Started",
        status: "fail",
        detail: "Correctly blocked — payment not captured",
      },
    ];

    return {
      orderId: order.orderId,
      summary:
        `Payment was declined or failed. The order is correctly held in pending state — ` +
        `no fulfillment was triggered, which is the expected behaviour.`,
      rootCause:
        "The payment gateway reported a failed transaction. " +
        "The system correctly blocked fulfillment and left the order in pending status.",
      evidence,
      timeline,
      confidence: "high",
      recommendedNextStep:
        "No action needed — the system is behaving correctly. " +
        "Notify the customer that their payment was declined and invite them to retry with a different payment method.",
      riskLevel: "low",
      automationEligible: false,
    };
  }

  // 2. Payment not yet captured (pending)
  if (payment && payment.internalStatus === "pending") {
    const evidence: EvidenceItem[] = [
      {
        label: "Payment Captured",
        status: "fail",
        detail: "Payment still pending",
      },
      { label: "Fulfillment Started", status: "fail" },
    ];

    const hoursWaiting = hoursSince(order.createdAt);
    const stalePayment = hoursWaiting > 1;

    return {
      orderId: order.orderId,
      summary:
        `Payment has not been captured after ${hoursWaiting.toFixed(1)} hours. ` +
        `No fulfillment has been initiated.`,
      rootCause: stalePayment
        ? "Payment capture timed out or was abandoned by the customer. The payment gateway session may have expired."
        : "Payment is still being processed by the gateway. This is normal for recent orders.",
      evidence,
      timeline,
      confidence: stalePayment ? "high" : "medium",
      recommendedNextStep: stalePayment
        ? "Verify with the payment gateway whether the transaction was abandoned. If so, cancel the order and notify the customer."
        : "Wait for payment gateway confirmation. No action needed yet.",
      riskLevel: stalePayment ? "medium" : "low",
      automationEligible: false,
    };
  }

  // 3. Fulfillment failed
  if (ful && ful.status === "failed") {
    const isInventoryIssue =
      ful.failureReason?.toLowerCase().includes("inventory") ||
      ful.failureReason?.toLowerCase().includes("out of stock");

    const evidence: EvidenceItem[] = [
      { label: "Payment Captured", status: "pass" },
      {
        label: "Inventory Reserved",
        status: isInventoryIssue ? "fail" : "pass",
      },
      {
        label: "Fulfillment Started",
        status: ful.startedAt ? "fail" : "fail",
        detail: ful.failureReason ?? "Unknown failure",
      },
      { label: "Order Fulfilled", status: "fail" },
    ];

    return {
      orderId: order.orderId,
      summary:
        `Payment was captured successfully but fulfillment failed. ` +
        (ful.failureReason
          ? `Failure reason: ${ful.failureReason}.`
          : "No failure reason was recorded."),
      rootCause: isInventoryIssue
        ? "Inventory was unavailable at the time fulfillment was attempted. " +
          "The item is out of stock in the warehouse."
        : "Fulfillment failed due to a provider-side error. " +
          "The delivery partner was either unreachable or rejected the shipment request.",
      evidence,
      timeline,
      confidence: "high",
      recommendedNextStep: isInventoryIssue
        ? "Check current inventory levels for the affected SKU. " +
          "Options: (1) Wait for restock and retry, or (2) Cancel the order and issue a full refund."
        : "Retry fulfillment processing. If the retry fails again, " +
          "escalate to the delivery partner operations team.",
      riskLevel: isInventoryIssue ? "medium" : "low",
      automationEligible: !isInventoryIssue,
    };
  }

  // 4. Fulfillment never started (payment captured but no fulfillment)
  if (
    payment &&
    payment.internalStatus === "captured" &&
    ful &&
    ful.status === "not_started"
  ) {
    const hoursElapsed = hoursSince(order.createdAt);
    const hasInventoryEvent = timeline.some((e) =>
      e.eventType.includes("inventory_reserved"),
    );

    const evidence: EvidenceItem[] = [
      { label: "Payment Captured", status: "pass" },
      {
        label: "Inventory Reserved",
        status: hasInventoryEvent ? "pass" : "unknown",
      },
      { label: "Fulfillment Not Started", status: "fail" },
    ];

    return {
      orderId: order.orderId,
      summary:
        `Payment was captured ${hoursElapsed.toFixed(1)} hours ago. ` +
        `Inventory was${hasInventoryEvent ? "" : " not"} reserved. ` +
        `The order has never progressed to fulfillment.`,
      rootCause:
        "The fulfillment pipeline did not pick up this order after payment capture. " +
        "This may indicate a queue failure, misconfiguration, or a dropped webhook.",
      evidence,
      timeline,
      confidence: "high",
      recommendedNextStep:
        "Retry fulfillment processing. The payment and inventory state are valid — " +
        "the order only needs to be re-submitted to the fulfillment pipeline.",
      riskLevel: "low",
      automationEligible: true,
    };
  }

  // 5. Stuck in processing (order flagged as stuck OR processing > threshold)
  const isStuck =
    order.status === "stuck" ||
    (order.status === "processing" &&
      hoursSince(order.createdAt) > STUCK_THRESHOLD_HOURS);

  if (isStuck) {
    const stuckHours = order.stuckSince
      ? hoursSince(order.stuckSince)
      : hoursSince(order.updatedAt);

    const hasDuplicateFulfillment = hasDuplicateEvents(
      timeline,
      "fulfillment_started",
    );

    const evidence: EvidenceItem[] = [
      { label: "Payment Captured", status: "pass" },
      {
        label: "Fulfillment Started",
        status: ful?.startedAt ? "pass" : "fail",
      },
      {
        label: "Order Stuck",
        status: "fail",
        detail: `No progress for ${stuckHours.toFixed(1)} hours`,
      },
      ...(hasDuplicateFulfillment
        ? [
            {
              label: "Duplicate Fulfillment Event",
              status: "fail" as const,
              detail: "Processing deadlock detected",
            } satisfies EvidenceItem,
          ]
        : []),
    ];

    return {
      orderId: order.orderId,
      summary:
        `Order has been stuck in processing for ${stuckHours.toFixed(1)} hours with no progress. ` +
        (hasDuplicateFulfillment
          ? "A duplicate fulfillment event was detected, which may have caused a processing deadlock."
          : ""),
      rootCause: hasDuplicateFulfillment
        ? "Duplicate fulfillment events triggered a processing deadlock. " +
          "The system received the same fulfillment signal twice and entered an inconsistent state."
        : "The order entered a processing state but no downstream system acknowledged it. " +
          "This may indicate a queue timeout, worker crash, or network partition.",
      evidence,
      timeline,
      confidence: "medium",
      recommendedNextStep:
        "Use update_order_status with dry_run=true to preview impact, then manually advance " +
        "the order to 'processing' or 'cancelled' after reviewing the timeline.",
      riskLevel: "medium",
      automationEligible: false,
    };
  }

  // 6. Fulfillment delayed (in processing but no update for > threshold)
  if (ful && ful.status === "processing") {
    const delayHours = hoursSince(ful.updatedAt);

    if (delayHours > FULFILLMENT_DELAY_THRESHOLD_HOURS) {
      const evidence: EvidenceItem[] = [
        { label: "Payment Captured", status: "pass" },
        { label: "Fulfillment Started", status: "pass" },
        {
          label: "Fulfillment Progress",
          status: "fail",
          detail: `No update for ${delayHours.toFixed(1)} hours`,
        },
        { label: "Order Fulfilled", status: "fail" },
      ];

      return {
        orderId: order.orderId,
        summary:
          `Fulfillment is in progress but has not received an update from the delivery ` +
          `partner for ${delayHours.toFixed(1)} hours.`,
        rootCause:
          "The delivery partner has not sent a status update. This may indicate a slow " +
          "processing queue, a logistics delay, or a webhook delivery failure.",
        evidence,
        timeline,
        confidence: "medium",
        recommendedNextStep:
          "Check the delivery partner portal for the latest shipment status. " +
          `If no update is available after ${FULFILLMENT_DELAY_THRESHOLD_HOURS + 1} hours total, ` +
          "retry fulfillment processing.",
        riskLevel: "low",
        automationEligible: false,
      };
    }
  }

  // 7. Healthy — no issues detected
  const evidence: EvidenceItem[] = [
    {
      label: "Payment Captured",
      status: payment?.internalStatus === "captured" ? "pass" : "unknown",
    },
    {
      label: "Fulfillment Initiated",
      status: ful?.startedAt ? "pass" : "unknown",
    },
    { label: "Order Status", status: "pass", detail: order.status },
  ];

  return {
    orderId: order.orderId,
    summary: `Order is in a healthy state. Current status: ${order.status}.`,
    rootCause: "No operational issue detected.",
    evidence,
    timeline,
    confidence: "high",
    recommendedNextStep: "No action required. Monitor for normal progression.",
    riskLevel: "low",
    automationEligible: false,
  };
}
