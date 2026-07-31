/**
 * Operations Service
 *
 * Provides fleet-level views of the order operation:
 *  - listPendingInvestigations: orders that need attention, grouped by issue
 *  - getOperationsSummary: aggregate metrics + recent audit trail
 *
 * ID strategy:
 *  - Internal maps use order.id (UUID) as key for FK correlation
 *  - All returned PendingInvestigation objects expose order.orderId (human-readable)
 *  - Audit entries are joined with orders to resolve UUID → human-readable orderId
 */

import { ne, and, gt, desc, eq } from "drizzle-orm";
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

import { hoursSince, isoAfter } from "../lib/date.utils.js";

export async function listPendingInvestigations(opts?: {
  limit?: number;
  issueCategory?: IssueCategory;
}): Promise<PendingInvestigation[]> {
  const limit = opts?.limit ?? DEFAULT_PAGE_LIMIT;

  // Single JOIN query — scoped to non-terminal orders only.
  // This replaces the previous pattern of fetching entire tables into memory
  // and building Maps to correlate them, which was an OOM risk at scale.
  const rows = await db
    .select({
      // Order fields
      id: orders.id,
      orderId: orders.orderId,
      status: orders.status,
      customerEmail: orders.customerEmail,
      amount: orders.amount,
      currency: orders.currency,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
      stuckSince: orders.stuckSince,
      // Payment fields (nullable — LEFT JOIN)
      paymentInternalStatus: payments.internalStatus,
      paymentProviderStatus: payments.providerStatus,
      // Fulfillment fields (nullable — LEFT JOIN)
      fulfillmentStatus: fulfillment.status,
      fulfillmentFailureReason: fulfillment.failureReason,
      fulfillmentUpdatedAt: fulfillment.updatedAt,
    })
    .from(orders)
    .leftJoin(payments, eq(payments.orderId, orders.id))
    .leftJoin(fulfillment, eq(fulfillment.orderId, orders.id))
    .where(and(ne(orders.status, "fulfilled"), ne(orders.status, "cancelled")));

  if (rows.length === 0) return [];

  const results: PendingInvestigation[] = [];

  for (const row of rows) {
    const payment =
      row.paymentInternalStatus !== null
        ? {
            internalStatus: row.paymentInternalStatus!,
            providerStatus: row.paymentProviderStatus!,
          }
        : null;
    const ful =
      row.fulfillmentStatus !== null
        ? {
            status: row.fulfillmentStatus!,
            failureReason: row.fulfillmentFailureReason,
            updatedAt: row.fulfillmentUpdatedAt!,
          }
        : null;

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
      const hoursWaiting = hoursSince(row.createdAt);
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
      const elapsedHours = hoursSince(row.createdAt);
      issueSummary = `Payment captured ${elapsedHours.toFixed(1)}h ago but fulfillment never started`;
    } else if (
      row.status === "stuck" ||
      (row.status === "processing" &&
        hoursSince(row.createdAt) > STUCK_THRESHOLD_HOURS)
    ) {
      issueCategory = "stuck_processing";
      stuckSinceHours = row.stuckSince
        ? hoursSince(row.stuckSince)
        : hoursSince(row.updatedAt);
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
      orderId: row.orderId,
      issueCategory,
      issueSummary,
      amount: row.amount,
      currency: row.currency,
      customerEmail: row.customerEmail,
      stuckSinceHours,
      createdAt: row.createdAt,
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
    // Join audit_log with orders to resolve UUID → human-readable orderId
    db
      .select({
        id: auditLog.id,
        orderId: orders.orderId, // human-readable from the join
        action: auditLog.action,
        reason: auditLog.reason,
        outcome: auditLog.outcome,
        performedAt: auditLog.performedAt,
      })
      .from(auditLog)
      .innerJoin(orders, eq(auditLog.orderId, orders.id))
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
    orderId: a.orderId, // already resolved to human-readable via join
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
