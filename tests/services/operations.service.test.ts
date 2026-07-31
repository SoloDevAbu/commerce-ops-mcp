import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: mockSelect,
  },
}));

function makeJoinedRow(overrides: Record<string, unknown> = {}) {
  return {
    // Order fields
    id: "uuid-order-1",
    orderId: "ORD-1001",
    status: "processing",
    customerEmail: "test@example.com",
    amount: 2500,
    currency: "INR",
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
    updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    stuckSince: null,
    // Payment fields (nullable — LEFT JOIN)
    paymentInternalStatus: "captured",
    paymentProviderStatus: "captured",
    // Fulfillment fields (nullable — LEFT JOIN)
    fulfillmentStatus: "processing",
    fulfillmentFailureReason: null,
    fulfillmentUpdatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function setupListMock(rows: ReturnType<typeof makeJoinedRow>[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
  mockSelect.mockReturnValueOnce(chain);
  return chain;
}

describe("listPendingInvestigations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getService() {
    const mod = await import("../../src/services/operations.service.js");
    return mod.listPendingInvestigations;
  }

  it("returns an empty array when the JOIN query returns no rows", async () => {
    setupListMock([]);
    const list = await getService();
    const result = await list();
    expect(result).toEqual([]);
  });

  it("classifies payment_mismatch (internal vs provider status differs)", async () => {
    setupListMock([
      makeJoinedRow({
        paymentInternalStatus: "captured",
        paymentProviderStatus: "failed",
      }),
    ]);
    const list = await getService();
    const result = await list();

    expect(result).toHaveLength(1);
    expect(result[0].issueCategory).toBe("payment_mismatch");
    expect(result[0].issueSummary).toMatch(/mismatch/i);
  });

  it("classifies payment_mismatch when payment is pending", async () => {
    setupListMock([
      makeJoinedRow({
        status: "pending",
        paymentInternalStatus: "pending",
        paymentProviderStatus: "pending",
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      }),
    ]);
    const list = await getService();
    const result = await list();

    expect(result[0].issueCategory).toBe("payment_mismatch");
    expect(result[0].issueSummary).toMatch(/pending/i);
  });

  it("classifies fulfillment_failure when fulfillment status is failed", async () => {
    setupListMock([
      makeJoinedRow({
        fulfillmentStatus: "failed",
        fulfillmentFailureReason: "delivery partner unreachable",
      }),
    ]);
    const list = await getService();
    const result = await list();

    expect(result[0].issueCategory).toBe("fulfillment_failure");
    expect(result[0].issueSummary).toContain("delivery partner unreachable");
  });

  it("classifies fulfillment_failure when payment captured but fulfillment not_started", async () => {
    setupListMock([
      makeJoinedRow({
        paymentInternalStatus: "captured",
        paymentProviderStatus: "captured",
        fulfillmentStatus: "not_started",
      }),
    ]);
    const list = await getService();
    const result = await list();

    expect(result[0].issueCategory).toBe("fulfillment_failure");
    expect(result[0].issueSummary).toMatch(/never started/i);
  });

  it("classifies stuck_processing when order status is stuck", async () => {
    setupListMock([
      makeJoinedRow({
        status: "stuck",
        stuckSince: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
        fulfillmentStatus: "processing",
      }),
    ]);
    const list = await getService();
    const result = await list();

    expect(result[0].issueCategory).toBe("stuck_processing");
    expect(result[0].stuckSinceHours).toBeGreaterThan(0);
  });

  it("classifies stuck_processing when order has been processing > threshold hours", async () => {
    // STUCK_THRESHOLD_HOURS = 4
    setupListMock([
      makeJoinedRow({
        status: "processing",
        createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
        fulfillmentStatus: "processing",
        fulfillmentUpdatedAt: new Date(
          Date.now() - 10 * 60 * 1000,
        ).toISOString(), // recent update — not a delay
      }),
    ]);
    const list = await getService();
    const result = await list();

    expect(result[0].issueCategory).toBe("stuck_processing");
  });

  it("classifies fulfillment_delay when fulfillment is processing with no update", async () => {
    setupListMock([
      makeJoinedRow({
        status: "processing",
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h — not stuck
        fulfillmentStatus: "processing",
        // FULFILLMENT_DELAY_THRESHOLD_HOURS = 2
        fulfillmentUpdatedAt: new Date(
          Date.now() - 3 * 60 * 60 * 1000,
        ).toISOString(),
      }),
    ]);
    const list = await getService();
    const result = await list();

    expect(result[0].issueCategory).toBe("fulfillment_delay");
  });

  it("skips orders with no issue category (healthy orders)", async () => {
    // Healthy: payment captured, fulfillment processing and recently updated
    setupListMock([
      makeJoinedRow({
        status: "processing",
        createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        paymentInternalStatus: "captured",
        paymentProviderStatus: "captured",
        fulfillmentStatus: "processing",
        fulfillmentUpdatedAt: new Date(
          Date.now() - 10 * 60 * 1000,
        ).toISOString(),
      }),
    ]);
    const list = await getService();
    const result = await list();

    expect(result).toHaveLength(0);
  });

  it("filters by issueCategory when provided", async () => {
    setupListMock([
      makeJoinedRow({
        orderId: "ORD-A",
        paymentInternalStatus: "captured",
        paymentProviderStatus: "failed",
      }),
    ]);
    const list = await getService();
    // Ask for only fulfillment_failure — the mismatch order should be skipped
    const result = await list({ issueCategory: "fulfillment_failure" });
    expect(result).toHaveLength(0);
  });

  it("sorts by severity: payment_mismatch before fulfillment_failure", async () => {
    setupListMock([
      makeJoinedRow({
        id: "uuid-b",
        orderId: "ORD-B",
        fulfillmentStatus: "failed",
        fulfillmentFailureReason: "provider error",
        paymentInternalStatus: "captured",
        paymentProviderStatus: "captured",
      }),
      makeJoinedRow({
        id: "uuid-a",
        orderId: "ORD-A",
        paymentInternalStatus: "captured",
        paymentProviderStatus: "failed",
      }),
    ]);
    const list = await getService();
    const result = await list();

    expect(result[0].issueCategory).toBe("payment_mismatch");
    expect(result[1].issueCategory).toBe("fulfillment_failure");
  });

  it("respects the limit option", async () => {
    const manyRows = Array.from({ length: 5 }, (_, i) =>
      makeJoinedRow({
        id: `uuid-${i}`,
        orderId: `ORD-${i}`,
        paymentInternalStatus: "captured",
        paymentProviderStatus: "failed",
      }),
    );
    setupListMock(manyRows);
    const list = await getService();
    const result = await list({ limit: 3 });

    expect(result).toHaveLength(3);
  });

  it("returns human-readable orderId (not UUID)", async () => {
    setupListMock([
      makeJoinedRow({
        paymentInternalStatus: "captured",
        paymentProviderStatus: "failed",
      }),
    ]);
    const list = await getService();
    const result = await list();

    expect(result[0].orderId).toBe("ORD-1001");
    expect(result[0].orderId).not.toContain("uuid");
  });

  it("includes stuckSinceHours as a number (not string) for stuck orders", async () => {
    setupListMock([
      makeJoinedRow({
        status: "stuck",
        stuckSince: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
        fulfillmentStatus: "processing",
      }),
    ]);
    const list = await getService();
    const result = await list();

    expect(typeof result[0].stuckSinceHours).toBe("number");
  });

  it("returns null for stuckSinceHours when order is not stuck", async () => {
    setupListMock([
      makeJoinedRow({
        paymentInternalStatus: "captured",
        paymentProviderStatus: "failed",
      }),
    ]);
    const list = await getService();
    const result = await list();

    expect(result[0].stuckSinceHours).toBeNull();
  });

  it("handles orders with no payment (null payment fields from LEFT JOIN)", async () => {
    // A LEFT JOIN can return null payment fields if no payment row exists.
    // Such an order should not be classified (no issueCategory) and skipped.
    setupListMock([
      makeJoinedRow({
        paymentInternalStatus: null,
        paymentProviderStatus: null,
        fulfillmentStatus: null,
        fulfillmentFailureReason: null,
        fulfillmentUpdatedAt: null,
      }),
    ]);
    const list = await getService();
    const result = await list();

    // No issue category can be determined without payment or fulfillment data
    expect(result).toHaveLength(0);
  });
});
