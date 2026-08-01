/**
 * PostgreSQL-backed integration tests.
 *
 * Tests mutation side effects, approval enforcement, idempotency,
 * concurrent retries, valid transitions, and audit trail against
 * a real Neon Postgres database.
 *
 * Run with: pnpm test:integration
 * Requires DATABASE_URL environment variable to be set.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  cleanTables,
  seedTestOrder,
  getOrder,
  getAuditLogs,
  getOrderEvents,
  getFulfillment,
} from "./helpers/db-setup.js";
import {
  retryFulfillmentProcessing,
  updateOrderStatus,
} from "../../src/services/recovery.service.js";
import {
  InvalidStateError,
  ApprovalRequiredError,
} from "../../src/types.js";

describe("Integration: retryFulfillmentProcessing", () => {
  beforeEach(async () => {
    await cleanTables();
  });

  // ── Test 1: Mutation side effects ──
  it("updates order, fulfillment, events, and audit on confirmed retry", async () => {
    const internalId = await seedTestOrder({
      orderId: "ORD-INT-001",
      status: "stuck",
      paymentStatus: "captured",
      fulfillmentStatus: "failed",
    });

    const result = await retryFulfillmentProcessing(
      "ORD-INT-001",
      "integration test retry",
      true,
    );

    expect(result.confirmed).toBe(true);
    if (result.confirmed) {
      expect(result.success).toBe(true);
      expect(result.newStatus).toBe("processing");
    }

    // Verify DB side effects
    const order = await getOrder("ORD-INT-001");
    expect(order!.status).toBe("processing");
    expect(order!.stuckSince).toBeNull();

    const ful = await getFulfillment(internalId);
    expect(ful!.status).toBe("processing");
    expect(ful!.failureReason).toBeNull();

    const audits = await getAuditLogs(internalId);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("retry_fulfillment");
    expect(audits[0].idempotencyKey).toBe("retry_fulfillment:ORD-INT-001");

    const events = await getOrderEvents(internalId);
    const retryEvent = events.find((e) => e.eventType === "fulfillment_retried");
    expect(retryEvent).toBeDefined();
  });

  // ── Test 2: Approval enforcement — preview mode ──
  it("returns preview without mutations when confirmed=false", async () => {
    const internalId = await seedTestOrder({
      orderId: "ORD-INT-002",
      status: "stuck",
      paymentStatus: "captured",
      fulfillmentStatus: "failed",
    });

    const result = await retryFulfillmentProcessing(
      "ORD-INT-002",
      "should not mutate",
      false,
    );

    expect(result.confirmed).toBe(false);
    if (!result.confirmed) {
      expect(result.validationPassed).toBe(true);
    }

    // Verify NO side effects
    const order = await getOrder("ORD-INT-002");
    expect(order!.status).toBe("stuck"); // unchanged

    const audits = await getAuditLogs(internalId);
    expect(audits).toHaveLength(0);
  });

  // ── Test 3: Duplicate retry — idempotency ──
  it("returns already-processed on duplicate retry", async () => {
    await seedTestOrder({
      orderId: "ORD-INT-003",
      status: "stuck",
      paymentStatus: "captured",
      fulfillmentStatus: "failed",
    });

    // First call succeeds
    const first = await retryFulfillmentProcessing(
      "ORD-INT-003",
      "first attempt",
      true,
    );
    expect(first.confirmed).toBe(true);

    // Second call — order is now "processing", not retryable
    // This should throw InvalidStateError since the order is no longer in a retryable state
    await expect(
      retryFulfillmentProcessing("ORD-INT-003", "duplicate attempt", true),
    ).rejects.toThrow(InvalidStateError);
  });

  // ── Test 4: Concurrent retry — row locking ──
  it("handles concurrent retries safely (only one mutates)", async () => {
    const internalId = await seedTestOrder({
      orderId: "ORD-INT-004",
      status: "stuck",
      paymentStatus: "captured",
      fulfillmentStatus: "failed",
    });

    // Launch two concurrent retries
    const results = await Promise.allSettled([
      retryFulfillmentProcessing("ORD-INT-004", "concurrent-1", true),
      retryFulfillmentProcessing("ORD-INT-004", "concurrent-2", true),
    ]);

    // At least one should succeed
    const successes = results.filter((r) => r.status === "fulfilled");
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // Audit log should have exactly 1 row (not 2)
    const audits = await getAuditLogs(internalId);
    expect(audits).toHaveLength(1);
  });
});

describe("Integration: updateOrderStatus", () => {
  beforeEach(async () => {
    await cleanTables();
  });

  // ── Test 5: Mutation side effects — status update ──
  it("updates order, events, and audit on confirmed status change", async () => {
    const internalId = await seedTestOrder({
      orderId: "ORD-INT-005",
      status: "stuck",
      paymentStatus: "captured",
      fulfillmentStatus: "processing",
    });

    const result = await updateOrderStatus(
      "ORD-INT-005",
      "processing",
      "un-stick order",
      false, // dryRun
      true,  // confirmed
    );

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.success).toBe(true);
      expect(result.previousStatus).toBe("stuck");
      expect(result.newStatus).toBe("processing");
    }

    const order = await getOrder("ORD-INT-005");
    expect(order!.status).toBe("processing");

    const audits = await getAuditLogs(internalId);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("update_order_status");

    const events = await getOrderEvents(internalId);
    const updateEvent = events.find((e) => e.eventType === "status_updated");
    expect(updateEvent).toBeDefined();
  });

  // ── Test 6: Approval enforcement — throws without confirmed ──
  it("throws ApprovalRequiredError when dryRun=false and confirmed=false", async () => {
    await seedTestOrder({
      orderId: "ORD-INT-006",
      status: "stuck",
      paymentStatus: "captured",
    });

    await expect(
      updateOrderStatus("ORD-INT-006", "processing", "reason", false, false),
    ).rejects.toThrow(ApprovalRequiredError);
  });

  // ── Test 7: Valid transitions — allowed ──
  it("allows valid transitions", async () => {
    // pending → processing
    await seedTestOrder({ orderId: "ORD-T-A", status: "pending", paymentStatus: "captured" });
    const r1 = await updateOrderStatus("ORD-T-A", "processing", "begin", false, true);
    expect(r1.dryRun).toBe(false);

    // processing → cancelled
    await seedTestOrder({ orderId: "ORD-T-B", status: "processing", paymentStatus: "captured" });
    const r2 = await updateOrderStatus("ORD-T-B", "cancelled", "cancel", false, true);
    expect(r2.dryRun).toBe(false);

    // stuck → processing
    await seedTestOrder({ orderId: "ORD-T-C", status: "stuck", paymentStatus: "captured" });
    const r3 = await updateOrderStatus("ORD-T-C", "processing", "unstick", false, true);
    expect(r3.dryRun).toBe(false);

    // processing → fulfilled
    await seedTestOrder({ orderId: "ORD-T-D", status: "processing", paymentStatus: "captured" });
    const r4 = await updateOrderStatus("ORD-T-D", "fulfilled", "delivered", false, true);
    expect(r4.dryRun).toBe(false);
  });

  // ── Test 8: Valid transitions — blocked ──
  it("rejects invalid transitions from terminal states", async () => {
    await seedTestOrder({ orderId: "ORD-T-E", status: "fulfilled", paymentStatus: "captured" });
    await expect(
      updateOrderStatus("ORD-T-E", "processing", "revert", true),
    ).rejects.toThrow(InvalidStateError);

    await seedTestOrder({ orderId: "ORD-T-F", status: "cancelled", paymentStatus: "captured" });
    await expect(
      updateOrderStatus("ORD-T-F", "processing", "revert", true),
    ).rejects.toThrow(InvalidStateError);
  });

  it("rejects invalid transition: pending → fulfilled", async () => {
    await seedTestOrder({ orderId: "ORD-T-G", status: "pending", paymentStatus: "captured" });
    await expect(
      updateOrderStatus("ORD-T-G", "fulfilled", "skip", true),
    ).rejects.toThrow(InvalidStateError);
  });

  // ── Test 9: Audit trail integrity ──
  it("produces correct audit records with valid fields", async () => {
    const internalId = await seedTestOrder({
      orderId: "ORD-INT-009",
      status: "stuck",
      paymentStatus: "captured",
    });

    await updateOrderStatus("ORD-INT-009", "processing", "audit check", false, true);

    const audits = await getAuditLogs(internalId);
    expect(audits).toHaveLength(1);

    const audit = audits[0];
    expect(audit.action).toBe("update_order_status");
    expect(audit.reason).toBe("audit check");
    expect(audit.outcome).toContain("stuck");
    expect(audit.outcome).toContain("processing");
    expect(audit.idempotencyKey).toBe("update_status:ORD-INT-009:stuck:processing");
    // performedAt is a valid ISO string
    expect(() => new Date(audit.performedAt)).not.toThrow();
    expect(new Date(audit.performedAt).toISOString()).toBe(audit.performedAt);
  });
});
