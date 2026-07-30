/**
 * Unit tests for investigateOrder().
 * The database is fully mocked — tests exercise the decision-tree logic
 * in isolation without any real DB connection.
 *
 * Mock architecture:
 *  - vi.mock("../../src/db/client.js") returns a chainable `db` spy
 *  - Each test configures what db.select().from().where() (and friends)
 *    resolves to, simulating different DB states.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OrderNotFoundError } from "../../src/types.js";

// DB mock — must be declared before any import that uses the db
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();

// Each call to db.select() returns a chainable object.
// We make each method return "this" equivalent so we can chain .from().where().
const chainable = {
  select: mockSelect,
  from: mockFrom,
  where: mockWhere,
  orderBy: mockOrderBy,
};

vi.mock("../../src/db/client.js", () => ({
  db: {
    select: mockSelect,
  },
}));

// Helper builders
function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "uuid-order-1",
    orderId: "ORD-1001",
    status: "processing",
    customerEmail: "test@example.com",
    amount: 2500,
    currency: "INR",
    items: "[]",
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    stuckSince: null,
    ...overrides,
  };
}

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "uuid-payment-1",
    orderId: "uuid-order-1",
    internalStatus: "captured",
    providerStatus: "captured",
    amount: 2500,
    currency: "INR",
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFulfillment(overrides: Record<string, unknown> = {}) {
  return {
    id: "uuid-fulfillment-1",
    orderId: "uuid-order-1",
    status: "processing",
    failureReason: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
    ...overrides,
  };
}

// Configures the mock chain for a full investigateOrder call.
// The service does:
//   1) db.select().from(orders).where(...)                -> orderRows
//   2) db.select().from(payments).where(...)              -> paymentRows   (via Promise.all)
//   3) db.select().from(fulfillment).where(...)           -> fulfillRows   (via Promise.all)
//   4) db.select().from(orderEvents).where(...).orderBy() -> eventRows     (via Promise.all)
function setupDbMock({
  orderRows = [makeOrder()],
  paymentRows = [makePayment()],
  fulfillRows = [makeFulfillment()],
  eventRows = [],
}: {
  orderRows?: ReturnType<typeof makeOrder>[];
  paymentRows?: ReturnType<typeof makePayment>[];
  fulfillRows?: ReturnType<typeof makeFulfillment>[];
  eventRows?: unknown[];
} = {}) {
  // Call 1: orders lookup
  const ordersChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(orderRows),
  };

  // Call 2: payments lookup
  const paymentsChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(paymentRows),
  };

  // Call 3: fulfillment lookup
  const fulfillmentChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(fulfillRows),
  };

  // Call 4: orderEvents lookup (has extra .orderBy())
  const eventsChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(eventRows),
  };

  mockSelect
    .mockReturnValueOnce(ordersChain) // call 1
    .mockReturnValueOnce(paymentsChain) // call 2 (Promise.all)
    .mockReturnValueOnce(fulfillmentChain) // call 3 (Promise.all)
    .mockReturnValueOnce(eventsChain); // call 4 (Promise.all)
}

describe("investigateOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Dynamically import AFTER mocks are registered
  async function getService() {
    const mod = await import("../../src/services/investigation.service.js");
    return mod.investigateOrder;
  }

  it("throws OrderNotFoundError when the order does not exist", async () => {
    const ordersChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]), // empty result
    };
    mockSelect.mockReturnValueOnce(ordersChain);

    const investigateOrder = await getService();
    await expect(investigateOrder("ORD-MISSING")).rejects.toThrow(
      OrderNotFoundError,
    );
  });

  it("detects payment status mismatch (high risk)", async () => {
    setupDbMock({
      paymentRows: [
        makePayment({ internalStatus: "captured", providerStatus: "failed" }),
      ],
    });

    const investigateOrder = await getService();
    const report = await investigateOrder("ORD-1001");

    expect(report.orderId).toBe("ORD-1001");
    expect(report.riskLevel).toBe("high");
    expect(report.confidence).toBe("high");
    expect(report.automationEligible).toBe(false);
    expect(report.summary).toMatch(/divergence/i);
  });

  it("detects payment failed + order pending (low risk, system behaving correctly)", async () => {
    setupDbMock({
      orderRows: [makeOrder({ status: "pending" })],
      paymentRows: [
        makePayment({ internalStatus: "failed", providerStatus: "failed" }),
      ],
      fulfillRows: [],
    });

    const investigateOrder = await getService();
    const report = await investigateOrder("ORD-1001");

    expect(report.riskLevel).toBe("low");
    expect(report.automationEligible).toBe(false);
    expect(report.summary).toMatch(/declined|failed/i);
  });

  it("detects pending payment (stale — more than 1h old)", async () => {
    setupDbMock({
      orderRows: [
        makeOrder({
          status: "pending",
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
        }),
      ],
      paymentRows: [
        makePayment({ internalStatus: "pending", providerStatus: "pending" }),
      ],
      fulfillRows: [],
    });

    const investigateOrder = await getService();
    const report = await investigateOrder("ORD-1001");

    expect(report.confidence).toBe("high");
    expect(report.riskLevel).toBe("medium");
    expect(report.automationEligible).toBe(false);
    expect(report.summary).toMatch(/not been captured/i);
  });

  it("detects pending payment (recent — less than 1h old)", async () => {
    setupDbMock({
      orderRows: [
        makeOrder({
          status: "pending",
          createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
        }),
      ],
      paymentRows: [
        makePayment({ internalStatus: "pending", providerStatus: "pending" }),
      ],
      fulfillRows: [],
    });

    const investigateOrder = await getService();
    const report = await investigateOrder("ORD-1001");

    expect(report.confidence).toBe("medium");
    expect(report.riskLevel).toBe("low");
  });

  it("detects fulfillment failure (non-inventory)", async () => {
    setupDbMock({
      paymentRows: [makePayment()],
      fulfillRows: [
        makeFulfillment({
          status: "failed",
          failureReason: "delivery partner unreachable",
        }),
      ],
    });

    const investigateOrder = await getService();
    const report = await investigateOrder("ORD-1001");

    expect(report.riskLevel).toBe("low");
    expect(report.automationEligible).toBe(true);
    expect(report.summary).toMatch(/fulfillment failed/i);
  });

  it("detects fulfillment failure due to inventory/out of stock", async () => {
    setupDbMock({
      paymentRows: [makePayment()],
      fulfillRows: [
        makeFulfillment({
          status: "failed",
          failureReason: "out of stock for SKU-789",
        }),
      ],
    });

    const investigateOrder = await getService();
    const report = await investigateOrder("ORD-1001");

    expect(report.riskLevel).toBe("medium");
    expect(report.automationEligible).toBe(false);
    expect(report.rootCause).toMatch(/inventory/i);
  });

  it("detects fulfillment never started (payment captured, not_started)", async () => {
    setupDbMock({
      paymentRows: [
        makePayment({ internalStatus: "captured", providerStatus: "captured" }),
      ],
      fulfillRows: [
        makeFulfillment({ status: "not_started", startedAt: null }),
      ],
    });

    const investigateOrder = await getService();
    const report = await investigateOrder("ORD-1001");

    expect(report.riskLevel).toBe("low");
    expect(report.automationEligible).toBe(true);
    expect(report.summary).toMatch(/never progressed to fulfillment/i);
  });

  it("detects order stuck in processing (status=stuck)", async () => {
    setupDbMock({
      orderRows: [
        makeOrder({
          status: "stuck",
          stuckSince: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      paymentRows: [makePayment()],
      fulfillRows: [makeFulfillment()],
    });

    const investigateOrder = await getService();
    const report = await investigateOrder("ORD-1001");

    expect(report.riskLevel).toBe("medium");
    expect(report.automationEligible).toBe(false);
    expect(report.summary).toMatch(/stuck in processing/i);
  });

  it("detects order stuck in processing (status=processing for > STUCK_THRESHOLD_HOURS)", async () => {
    // STUCK_THRESHOLD_HOURS = 4
    setupDbMock({
      orderRows: [
        makeOrder({
          status: "processing",
          createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      paymentRows: [makePayment()],
      fulfillRows: [makeFulfillment()],
    });

    const investigateOrder = await getService();
    const report = await investigateOrder("ORD-1001");

    expect(report.riskLevel).toBe("medium");
    expect(report.automationEligible).toBe(false);
  });

  it("detects fulfillment delay (in processing for > FULFILLMENT_DELAY_THRESHOLD_HOURS)", async () => {
    setupDbMock({
      orderRows: [
        makeOrder({
          status: "processing",
          createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        }),
      ],
      paymentRows: [makePayment()],
      fulfillRows: [
        makeFulfillment({
          status: "processing",
          updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3h ago — > 2h threshold
        }),
      ],
    });

    const investigateOrder = await getService();
    const report = await investigateOrder("ORD-1001");

    expect(report.riskLevel).toBe("low");
    expect(report.automationEligible).toBe(false);
    expect(report.summary).toMatch(/not received an update/i);
  });

  it("returns healthy report when no issues are detected", async () => {
    setupDbMock({
      orderRows: [
        makeOrder({
          status: "processing",
          createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        }),
      ],
      paymentRows: [makePayment()],
      fulfillRows: [
        makeFulfillment({
          status: "processing",
          updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        }),
      ],
    });

    const investigateOrder = await getService();
    const report = await investigateOrder("ORD-1001");

    expect(report.riskLevel).toBe("low");
    expect(report.rootCause).toBe("No operational issue detected.");
    expect(report.automationEligible).toBe(false);
  });

  it("always returns the human-readable orderId (not UUID) in report", async () => {
    setupDbMock();

    const investigateOrder = await getService();
    const report = await investigateOrder("ORD-1001");

    expect(report.orderId).toBe("ORD-1001");
    expect(report.orderId).not.toContain("uuid");
  });
});
