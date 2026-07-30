/**
 * Operations Service
 *
 * Provides fleet-level views of the order operation:
 *  - listPendingInvestigations: orders that need attention, grouped by issue
 *  - getOperationsSummary: aggregate metrics + recent audit trail
 */

import { ne, and, gt, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { orders, payments, fulfillment, auditLog } from "../db/schema.js";
import type {
  PendingInvestigation,
  IssueCategory,
  OperationsSummary,
  AuditEntry,
} from "../types.js";
import {
  STUCK_THRESHOLD_HOURS,
  FULFILLMENT_DELAY_THRESHOLD_HOURS,
  DEFAULT_PERIOD_HOURS,
  DEFAULT_PAGE_LIMIT,
} from "../constants.js";

function hoursSince(isoString: string | null | undefined): number {
  if (!isoString) return 0;
  return (Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60);
}

function isoAfter(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export async function listPendingInvestigations(opts?: {
  limit?: number;
  issueCategory?: IssueCategory;
}): Promise<PendingInvestigation[]> {
  const limit = opts?.limit ?? DEFAULT_PAGE_LIMIT;

  // Fetch all non-terminal orders
  const openOrders = await db
    .select()
    .from(orders)
    .where(and(ne(orders.status, "fulfilled"), ne(orders.status, "cancelled")));

  // Fetch related data in parallel
  const orderIds = openOrders.map((o) => o.id);
  if (orderIds.length === 0) return [];

  const [allPayments, allFulfillments] = await Promise.all([
    db.select().from(payments),
    db.select().from(fulfillment),
  ]);

  const paymentByOrder = new Map(allPayments.map((p) => [p.orderId, p]));
  const fulfillmentByOrder = new Map(
    allFulfillments.map((f) => [f.orderId, f]),
  );

  const results: PendingInvestigation[] = [];

  for (const order of openOrders) {
    const payment = paymentByOrder.get(order.id);
    const ful = fulfillmentByOrder.get(order.id);

    let issueCategory: IssueCategory | null = null;
    let issueSummary = "";
    let stuckSinceHours: number | null = null;

    // Classify issue category (mirrors investigation service priority order)
    if (
      payment &&
      payment.internalStatus !== payment.providerStatus &&
      !(
        payment.internalStatus === "pending" &&
        payment.providerStatus === "pending"
      )
    ) {
      issueCategory = "payment_mismatch";
      issueSummary = `Payment mismatch: internal="${payment.internalStatus}" provider="${payment.providerStatus}"`;
    } else if (payment && payment.internalStatus === "pending") {
      issueCategory = "payment_mismatch";
      const hoursWaiting = hoursSince(order.createdAt);
      issueSummary = `Payment has been pending for ${hoursWaiting.toFixed(1)} hours`;
    } else if (ful && ful.status === "failed") {
      issueCategory = "fulfillment_failure";
      issueSummary = ful.failureReason
        ? `Fulfillment failed: ${ful.failureReason}`
        : "Fulfillment failed with no recorded reason";
    } else if (
      payment?.internalStatus === "captured" &&
      ful?.status === "not_started"
    ) {
      issueCategory = "fulfillment_failure";
      const elapsedHours = hoursSince(order.createdAt);
      issueSummary = `Payment captured ${elapsedHours.toFixed(1)}h ago but fulfillment never started`;
    } else if (
      order.status === "stuck" ||
      (order.status === "processing" &&
        hoursSince(order.createdAt) > STUCK_THRESHOLD_HOURS)
    ) {
      issueCategory = "stuck_processing";
      stuckSinceHours = order.stuckSince
        ? hoursSince(order.stuckSince)
        : hoursSince(order.updatedAt);
      issueSummary = `Order stuck in processing for ${stuckSinceHours.toFixed(1)} hours`;
    } else if (
      ful?.status === "processing" &&
      hoursSince(ful.updatedAt) > FULFILLMENT_DELAY_THRESHOLD_HOURS
    ) {
      issueCategory = "fulfillment_delay";
      const delayHours = hoursSince(ful.updatedAt);
      issueSummary = `Fulfillment in progress but no update for ${delayHours.toFixed(1)} hours`;
    }

    if (!issueCategory) continue; // No issue — skip

    if (opts?.issueCategory && opts.issueCategory !== issueCategory) continue;

    results.push({
      orderId: order.id,
      issueCategory,
      issueSummary,
      amount: order.amount,
      currency: order.currency,
      customerEmail: order.customerEmail,
      stuckSinceHours,
      createdAt: order.createdAt,
    });
  }

  // Sort by severity: payment_mismatch first, then stuck, then fulfillment issues
  const SEVERITY: Record<IssueCategory, number> = {
    payment_mismatch: 0,
    stuck_processing: 1,
    fulfillment_failure: 2,
    fulfillment_delay: 3,
  };

  results.sort((a, b) => SEVERITY[a.issueCategory] - SEVERITY[b.issueCategory]);

  return results.slice(0, limit);
}

export async function getOperationsSummary(
  periodHours: number = DEFAULT_PERIOD_HOURS,
): Promise<OperationsSummary> {
  const cutoff = isoAfter(periodHours);

  // Fetch all orders and pending investigations in parallel
  const [allOrders, pendingItems, recentAudit] = await Promise.all([
    db.select().from(orders).where(gt(orders.createdAt, cutoff)),
    listPendingInvestigations({ limit: 1000 }), // Get all for counting
    db
      .select()
      .from(auditLog)
      .where(gt(auditLog.performedAt, cutoff))
      .orderBy(desc(auditLog.performedAt))
      .limit(10),
  ]);

  // Aggregate by issue category
  const byIssueCategory: Record<IssueCategory, number> = {
    payment_mismatch: 0,
    fulfillment_failure: 0,
    stuck_processing: 0,
    fulfillment_delay: 0,
  };

  for (const item of pendingItems) {
    byIssueCategory[item.issueCategory]++;
  }

  const auditEntries: AuditEntry[] = recentAudit.map((a) => ({
    id: a.id,
    orderId: a.orderId,
    action: a.action,
    reason: a.reason,
    outcome: a.outcome,
    performedAt: a.performedAt,
  }));

  return {
    generatedAt: new Date().toISOString(),
    periodHours,
    totalOrders: allOrders.length,
    ordersNeedingAttention: pendingItems.length,
    byIssueCategory,
    recentAuditActions: auditEntries,
  };
}
