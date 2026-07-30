/**
 * Unit tests for all formatting utilities in src/lib/format.ts.
 * These are pure functions - no DB or external dependencies.
 */

import { describe, it, expect } from "vitest";
import {
  formatEvidence,
  formatTimeline,
  formatInvestigationReport,
  formatPendingInvestigations,
  formatAuditEntry,
  formatOperationsSummary,
} from "../../src/lib/format.js";
import type {
  EvidenceItem,
  TimelineEvent,
  InvestigationReport,
  PendingInvestigation,
  AuditEntry,
  OperationsSummary,
} from "../../src/types.js";

// formatEvidence
describe("formatEvidence", () => {
  it("renders pass items with ✓", () => {
    const items: EvidenceItem[] = [
      { label: "Payment Captured", status: "pass" },
    ];
    expect(formatEvidence(items)).toBe("✓ Payment Captured");
  });

  it("renders fail items with ✗", () => {
    const items: EvidenceItem[] = [
      { label: "Fulfillment Started", status: "fail" },
    ];
    expect(formatEvidence(items)).toBe("✗ Fulfillment Started");
  });

  it("renders unknown items with ?", () => {
    const items: EvidenceItem[] = [
      { label: "Inventory Reserved", status: "unknown" },
    ];
    expect(formatEvidence(items)).toBe("? Inventory Reserved");
  });

  it("appends detail when present", () => {
    const items: EvidenceItem[] = [
      { label: "Payment Status", status: "fail", detail: "Provider: failed" },
    ];
    expect(formatEvidence(items)).toBe("✗ Payment Status — Provider: failed");
  });

  it("joins multiple items with newlines", () => {
    const items: EvidenceItem[] = [
      { label: "Payment Captured", status: "pass" },
      { label: "Fulfillment Started", status: "fail" },
    ];
    const result = formatEvidence(items);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("✓ Payment Captured");
    expect(lines[1]).toBe("✗ Fulfillment Started");
  });
});

// formatTimeline
describe("formatTimeline", () => {
  it('returns "No events recorded." for empty array', () => {
    expect(formatTimeline([])).toBe("No events recorded.");
  });

  it("formats a single event with timestamp, type, and description", () => {
    const events: TimelineEvent[] = [
      {
        timestamp: "2024-01-15T10:00:00.000Z",
        eventType: "order_created",
        description: "Order was created",
      },
    ];
    const result = formatTimeline(events);
    expect(result).toContain("order_created");
    expect(result).toContain("Order was created");
    // Should contain some formatted timestamp bracket
    expect(result).toMatch(/^\[.+\]/);
  });

  it("formats multiple events separated by newlines", () => {
    const events: TimelineEvent[] = [
      {
        timestamp: "2024-01-15T10:00:00.000Z",
        eventType: "order_created",
        description: "Created",
      },
      {
        timestamp: "2024-01-15T10:05:00.000Z",
        eventType: "payment_captured",
        description: "Payment OK",
      },
    ];
    const lines = formatTimeline(events).split("\n");
    expect(lines).toHaveLength(2);
  });
});

// formatInvestigationReport
describe("formatInvestigationReport", () => {
  const baseReport: InvestigationReport = {
    orderId: "ORD-1001",
    summary: "Payment mismatch detected.",
    rootCause: "Internal vs provider status divergence.",
    evidence: [{ label: "Payment Captured", status: "fail" }],
    timeline: [],
    confidence: "high",
    recommendedNextStep: "Contact payment provider.",
    riskLevel: "high",
    automationEligible: false,
  };

  it("includes the order ID in the header", () => {
    expect(formatInvestigationReport(baseReport)).toContain("ORD-1001");
  });

  it("includes summary section", () => {
    expect(formatInvestigationReport(baseReport)).toContain(
      "Payment mismatch detected.",
    );
  });

  it("includes root cause section", () => {
    expect(formatInvestigationReport(baseReport)).toContain(
      "Internal vs provider status divergence.",
    );
  });

  it('shows "No — human approval required" when automationEligible is false', () => {
    expect(formatInvestigationReport(baseReport)).toContain(
      "No — human approval required",
    );
  });

  it('shows "Yes — this action can be safely automated" when automationEligible is true', () => {
    const report = { ...baseReport, automationEligible: true };
    expect(formatInvestigationReport(report)).toContain(
      "Yes — this action can be safely automated",
    );
  });

  it("capitalises confidence label", () => {
    expect(formatInvestigationReport(baseReport)).toContain(
      "## Confidence: High",
    );
  });

  it("capitalises risk level label", () => {
    expect(formatInvestigationReport(baseReport)).toContain(
      "## Risk Level: High",
    );
  });
});

// formatPendingInvestigations
describe("formatPendingInvestigations", () => {
  it("returns a clean message when list is empty", () => {
    expect(formatPendingInvestigations([])).toContain(
      "No orders currently require attention",
    );
  });

  it("groups orders by issue category", () => {
    const items: PendingInvestigation[] = [
      {
        orderId: "ORD-100",
        issueCategory: "payment_mismatch",
        issueSummary: "Internal vs provider mismatch",
        amount: 5000,
        currency: "INR",
        customerEmail: "a@test.com",
        stuckSinceHours: null,
        createdAt: new Date().toISOString(),
      },
      {
        orderId: "ORD-101",
        issueCategory: "fulfillment_failure",
        issueSummary: "Fulfillment failed: out of stock",
        amount: 2500,
        currency: "INR",
        customerEmail: "b@test.com",
        stuckSinceHours: null,
        createdAt: new Date().toISOString(),
      },
    ];

    const result = formatPendingInvestigations(items);
    expect(result).toContain("Payment Mismatch");
    expect(result).toContain("Fulfillment Failure");
    expect(result).toContain("ORD-100");
    expect(result).toContain("ORD-101");
  });

  it("shows stuckSinceHours when present", () => {
    const items: PendingInvestigation[] = [
      {
        orderId: "ORD-200",
        issueCategory: "stuck_processing",
        issueSummary: "Stuck for 6h",
        amount: 1000,
        currency: "INR",
        customerEmail: "c@test.com",
        stuckSinceHours: 6.0,
        createdAt: new Date().toISOString(),
      },
    ];
    expect(formatPendingInvestigations(items)).toContain("Stuck 6.0h");
  });

  it("includes item count in header", () => {
    const items: PendingInvestigation[] = [
      {
        orderId: "ORD-300",
        issueCategory: "fulfillment_delay",
        issueSummary: "Delayed",
        amount: 999,
        currency: "INR",
        customerEmail: "d@test.com",
        stuckSinceHours: null,
        createdAt: new Date().toISOString(),
      },
    ];
    expect(formatPendingInvestigations(items)).toContain("1 orders");
  });
});

// formatAuditEntry
describe("formatAuditEntry", () => {
  it("includes orderId and action", () => {
    const entry: AuditEntry = {
      id: "audit-1",
      orderId: "ORD-500",
      action: "retry_fulfillment",
      reason: "Manual retry",
      outcome: "Fulfillment restarted",
      performedAt: "2024-01-15T10:00:00.000Z",
    };
    const result = formatAuditEntry(entry);
    expect(result).toContain("ORD-500");
    expect(result).toContain("retry_fulfillment");
    expect(result).toContain("Fulfillment restarted");
  });
});

// formatOperationsSummary
describe("formatOperationsSummary", () => {
  it("includes period hours in header", () => {
    const summary: OperationsSummary = {
      generatedAt: new Date().toISOString(),
      periodHours: 24,
      totalOrders: 50,
      ordersNeedingAttention: 5,
      byIssueCategory: {
        payment_mismatch: 2,
        fulfillment_failure: 1,
        stuck_processing: 1,
        fulfillment_delay: 1,
      },
      recentAuditActions: [],
    };
    const result = formatOperationsSummary(summary);
    expect(result).toContain("Last 24h");
    expect(result).toContain("50");
    expect(result).toContain("5");
  });

  it('shows "No recent actions recorded." when audit trail is empty', () => {
    const summary: OperationsSummary = {
      generatedAt: new Date().toISOString(),
      periodHours: 12,
      totalOrders: 10,
      ordersNeedingAttention: 0,
      byIssueCategory: {
        payment_mismatch: 0,
        fulfillment_failure: 0,
        stuck_processing: 0,
        fulfillment_delay: 0,
      },
      recentAuditActions: [],
    };
    expect(formatOperationsSummary(summary)).toContain(
      "No recent actions recorded.",
    );
  });

  it("lists audit entries when present", () => {
    const summary: OperationsSummary = {
      generatedAt: new Date().toISOString(),
      periodHours: 24,
      totalOrders: 5,
      ordersNeedingAttention: 1,
      byIssueCategory: {
        payment_mismatch: 1,
        fulfillment_failure: 0,
        stuck_processing: 0,
        fulfillment_delay: 0,
      },
      recentAuditActions: [
        {
          id: "a1",
          orderId: "ORD-900",
          action: "update_order_status",
          reason: "Manual correction",
          outcome: "Status changed",
          performedAt: new Date().toISOString(),
        },
      ],
    };
    expect(formatOperationsSummary(summary)).toContain("ORD-900");
    expect(formatOperationsSummary(summary)).toContain("update_order_status");
  });
});
