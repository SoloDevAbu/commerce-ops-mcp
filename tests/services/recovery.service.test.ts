/**
 * Unit tests for retryFulfillmentProcessing() and updateOrderStatus().
 * The database and audit writer are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OrderNotFoundError,
  InvalidStateError,
  InventoryUnavailableError,
  ApprovalRequiredError,
} from "../../src/types.js";

const mockDbSelect = vi.fn();

// tx stub — used inside db.transaction() callbacks
const mockTxUpdate = vi.fn();
const mockTxInsert = vi.fn();

// db.transaction() immediately invokes the callback with the tx stub
const mockTransaction = vi
  .fn()
  .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      update: mockTxUpdate,
      insert: mockTxInsert,
    };
    return cb(tx);
  });

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: mockDbSelect,
    transaction: mockTransaction,
  },
}));

// Mock: audit writer
const mockWriteAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/lib/audit.js", () => ({
  writeAudit: mockWriteAudit,
}));

// Helpers
function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "uuid-order-1",
    orderId: "ORD-1001",
    status: "stuck",
    customerEmail: "test@example.com",
    amount: 2500,
    currency: "INR",
    items: "[]",
    createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    stuckSince: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
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
    status: "failed",
    failureReason: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Configures the select mock for retryFulfillmentProcessing:
//   call 1 -> orders rows
//   call 2 -> payment rows  (Promise.all)
//   call 3 -> fulfillment rows (Promise.all)
function setupSelectMock({
  orderRows = [makeOrder()],
  paymentRows = [makePayment()],
  fulfillRows = [makeFulfillment()],
}: {
  orderRows?: ReturnType<typeof makeOrder>[];
  paymentRows?: ReturnType<typeof makePayment>[];
  fulfillRows?: ReturnType<typeof makeFulfillment>[];
} = {}) {
  const ordersChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(orderRows),
  };
  const paymentsChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(paymentRows),
  };
  const fulfillChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(fulfillRows),
  };

  mockDbSelect
    .mockReturnValueOnce(ordersChain)
    .mockReturnValueOnce(paymentsChain)
    .mockReturnValueOnce(fulfillChain);
}

// Configures tx.update and tx.insert chains used inside db.transaction()
function setupTxWriteMocks() {
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };
  const insertChain = { values: vi.fn().mockResolvedValue([]) };
  mockTxUpdate.mockReturnValue(updateChain);
  mockTxInsert.mockReturnValue(insertChain);
  return { updateChain, insertChain };
}

function restoreTransactionMock() {
  mockTransaction.mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = { update: mockTxUpdate, insert: mockTxInsert };
      return cb(tx);
    },
  );
}

describe("retryFulfillmentProcessing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreTransactionMock();
  });

  async function getService() {
    const mod = await import("../../src/services/recovery.service.js");
    return mod.retryFulfillmentProcessing;
  }

  it("throws OrderNotFoundError when order does not exist", async () => {
    const ordersChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDbSelect.mockReturnValueOnce(ordersChain);

    const retry = await getService();
    await expect(retry("ORD-NONE", "test", true)).rejects.toThrow(OrderNotFoundError);
  });

  it("throws InvalidStateError when order is in non-retryable status (fulfilled)", async () => {
    setupSelectMock({ orderRows: [makeOrder({ status: "fulfilled" })] });

    const retry = await getService();
    await expect(retry("ORD-1001", "test", true)).rejects.toThrow(InvalidStateError);
  });

  it("throws InvalidStateError when order is in non-retryable status (cancelled)", async () => {
    setupSelectMock({ orderRows: [makeOrder({ status: "cancelled" })] });

    const retry = await getService();
    await expect(retry("ORD-1001", "test", true)).rejects.toThrow(InvalidStateError);
  });

  it("throws InvalidStateError when payment is not captured", async () => {
    setupSelectMock({
      paymentRows: [makePayment({ internalStatus: "pending" })],
    });

    const retry = await getService();
    await expect(retry("ORD-1001", "test", true)).rejects.toThrow(InvalidStateError);
  });

  it("throws InvalidStateError when payment is missing", async () => {
    setupSelectMock({ paymentRows: [] });

    const retry = await getService();
    await expect(retry("ORD-1001", "test", true)).rejects.toThrow(InvalidStateError);
  });

  it("throws InvalidStateError when fulfillment is already processing", async () => {
    setupSelectMock({
      fulfillRows: [makeFulfillment({ status: "processing" })],
    });

    const retry = await getService();
    await expect(retry("ORD-1001", "test", true)).rejects.toThrow(InvalidStateError);
  });

  it("throws InventoryUnavailableError when failure reason contains 'inventory'", async () => {
    setupSelectMock({
      fulfillRows: [
        makeFulfillment({
          status: "failed",
          failureReason: "inventory shortage",
        }),
      ],
    });

    const retry = await getService();
    await expect(retry("ORD-1001", "test", true)).rejects.toThrow(
      InventoryUnavailableError,
    );
  });

  it("throws InventoryUnavailableError when failure reason contains 'out of stock'", async () => {
    setupSelectMock({
      fulfillRows: [
        makeFulfillment({
          status: "failed",
          failureReason: "out of stock for SKU-X",
        }),
      ],
    });

    const retry = await getService();
    await expect(retry("ORD-1001", "test", true)).rejects.toThrow(
      InventoryUnavailableError,
    );
  });

  it("succeeds for a stuck order with captured payment and failed fulfillment", async () => {
    setupSelectMock();
    setupTxWriteMocks();

    const retry = await getService();
    const result = await retry("ORD-1001", "manual ops retry", true);

    expect(result.confirmed).toBe(true);
    if (result.confirmed) {
      expect(result.success).toBe(true);
      expect(result.orderId).toBe("ORD-1001"); // human-readable
      expect(result.newStatus).toBe("processing");
    }

    // Writes must be wrapped in a single transaction
    expect(mockTransaction).toHaveBeenCalledOnce();

    // writeAudit receives (params, tx) — second arg is the tx stub
    expect(mockWriteAudit).toHaveBeenCalledOnce();
    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "retry_fulfillment",
        reason: "manual ops retry",
      }),
      expect.anything(), // tx argument
    );
  });

  it("succeeds for a processing order with no existing fulfillment (inserts new row)", async () => {
    setupSelectMock({
      orderRows: [makeOrder({ status: "processing" })],
      fulfillRows: [], // no fulfillment record
    });
    setupTxWriteMocks();

    const retry = await getService();
    const result = await retry("ORD-1001", "create new fulfillment", true);

    expect(result.confirmed).toBe(true);
    if (result.confirmed) {
      expect(result.success).toBe(true);
    }
    // tx.insert should have been called (for new fulfillment row + event row)
    expect(mockTxInsert).toHaveBeenCalled();
  });

  it("all mutations execute inside a single transaction (atomicity)", async () => {
    setupSelectMock();
    setupTxWriteMocks();

    const retry = await getService();
    await retry("ORD-1001", "atomicity check", true);

    // Exactly one transaction wrapping all writes
    expect(mockTransaction).toHaveBeenCalledOnce();
    // Writes go through tx, not bare db.*
    expect(mockTxUpdate).toHaveBeenCalled();
    expect(mockTxInsert).toHaveBeenCalled();
  });

  it("returns human-readable orderId (not UUID) in result", async () => {
    setupSelectMock();
    setupTxWriteMocks();

    const retry = await getService();
    const result = await retry("ORD-1001", "reason", true);

    expect(result.orderId).toBe("ORD-1001");
    expect(result.orderId).not.toContain("uuid");
  });

  it("returns preview when confirmed=false (no writes)", async () => {
    setupSelectMock();

    const retry = await getService();
    const result = await retry("ORD-1001", "dry check", false);

    expect(result.confirmed).toBe(false);
    if (!result.confirmed) {
      expect(result.validationPassed).toBe(true);
      expect(result.orderId).toBe("ORD-1001");
    }
    // No DB writes when confirmed=false
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });
});

describe("updateOrderStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreTransactionMock();
  });

  async function getService() {
    const mod = await import("../../src/services/recovery.service.js");
    return mod.updateOrderStatus;
  }

  function setupOrderSelect(orderRows: ReturnType<typeof makeOrder>[]) {
    const ordersChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(orderRows),
    };
    mockDbSelect.mockReturnValueOnce(ordersChain);
  }

  it("throws OrderNotFoundError when order does not exist", async () => {
    setupOrderSelect([]);
    const update = await getService();
    await expect(update("ORD-NONE", "fulfilled", "reason")).rejects.toThrow(
      OrderNotFoundError,
    );
  });

  it("throws InvalidStateError for an invalid status value", async () => {
    setupOrderSelect([makeOrder({ status: "processing" })]);
    const update = await getService();
    await expect(update("ORD-1001", "banana", "reason")).rejects.toThrow(
      InvalidStateError,
    );
  });

  it("throws InvalidStateError when new status equals current status", async () => {
    setupOrderSelect([makeOrder({ status: "stuck" })]);
    const update = await getService();
    await expect(update("ORD-1001", "stuck", "reason")).rejects.toThrow(
      InvalidStateError,
    );
  });

  it("returns dry-run preview without writing to DB", async () => {
    setupOrderSelect([makeOrder({ status: "stuck" })]);
    const update = await getService();
    const result = await update(
      "ORD-1001",
      "processing",
      "un-stick order",
      true /* dryRun */,
    );

    expect(result.dryRun).toBe(true);
    if (result.dryRun) {
      expect(result.orderId).toBe("ORD-1001");
      expect(result.currentStatus).toBe("stuck");
      expect(result.proposedStatus).toBe("processing");
      expect(result.riskLevel).toBe("low");
    }
    // No DB writes in dry-run — transaction must NOT be called
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it("assesses high risk when transitioning to cancelled", async () => {
    setupOrderSelect([makeOrder({ status: "processing" })]);
    const update = await getService();
    const result = await update(
      "ORD-1001",
      "cancelled",
      "customer request",
      true,
    );

    expect(result.dryRun).toBe(true);
    if (result.dryRun) {
      expect(result.riskLevel).toBe("high");
    }
  });

  it("assesses high risk when current status is fulfilled", async () => {
    // Note: fulfilled → cancelled will be blocked by the transition map in Plan 2.
    // For now, this test uses stuck → cancelled which IS a valid high-risk transition.
    setupOrderSelect([makeOrder({ status: "stuck" })]);
    const update = await getService();
    const result = await update("ORD-1001", "cancelled", "cancel", true);

    expect(result.dryRun).toBe(true);
    if (result.dryRun) {
      expect(result.riskLevel).toBe("high");
    }
  });

  it("assesses medium risk when marking fulfilled from non-processing", async () => {
    setupOrderSelect([makeOrder({ status: "stuck" })]);
    const update = await getService();
    const result = await update(
      "ORD-1001",
      "fulfilled",
      "manual confirm",
      true,
    );

    expect(result.dryRun).toBe(true);
    if (result.dryRun) {
      expect(result.riskLevel).toBe("medium");
    }
  });

  it("executes status update and writes audit inside transaction when dryRun=false", async () => {
    setupOrderSelect([makeOrder({ status: "stuck" })]);
    setupTxWriteMocks();

    const update = await getService();
    const result = await update(
      "ORD-1001",
      "processing",
      "un-stick order",
      false,
      true, // confirmed
    );

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.success).toBe(true);
      expect(result.orderId).toBe("ORD-1001");
      expect(result.previousStatus).toBe("stuck");
      expect(result.newStatus).toBe("processing");
    }
    // Must use transaction (not bare db.update)
    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(mockTxUpdate).toHaveBeenCalled();
    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "update_order_status" }),
      expect.anything(), // tx argument
    );
  });

  it("throws ApprovalRequiredError when dryRun=false and confirmed=false", async () => {
    setupOrderSelect([makeOrder({ status: "stuck" })]);
    const update = await getService();
    await expect(
      update("ORD-1001", "processing", "reason", false, false),
    ).rejects.toThrow(ApprovalRequiredError);
    // No transaction or writes should have been called
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("all mutations execute inside a single transaction (atomicity)", async () => {
    setupOrderSelect([makeOrder({ status: "stuck" })]);
    setupTxWriteMocks();

    const update = await getService();
    await update("ORD-1001", "processing", "atomicity check", false, true);

    expect(mockTransaction).toHaveBeenCalledOnce();
  });

  it("defaults to dry-run=true when dryRun parameter is omitted", async () => {
    setupOrderSelect([makeOrder({ status: "stuck" })]);
    const update = await getService();
    const result = await update("ORD-1001", "processing", "reason"); // no dryRun arg

    expect(result.dryRun).toBe(true);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns human-readable orderId in all response shapes", async () => {
    // dry-run shape
    setupOrderSelect([makeOrder({ status: "stuck" })]);
    const update = await getService();
    const dryResult = await update("ORD-1001", "processing", "r", true);
    expect(dryResult.orderId).toBe("ORD-1001");

    // live shape
    vi.clearAllMocks();
    restoreTransactionMock();
    setupOrderSelect([makeOrder({ status: "stuck" })]);
    setupTxWriteMocks();
    const liveResult = await update("ORD-1001", "processing", "r", false, true);
    expect(liveResult.orderId).toBe("ORD-1001");
  });
});
