/**
 * tests/types.test.ts
 *
 * Tests for custom error classes and type guards defined in src/types.ts.
 */

import { describe, it, expect } from "vitest";
import {
  OrderNotFoundError,
  InvalidStateError,
  InventoryUnavailableError,
} from "../src/types.js";

describe("OrderNotFoundError", () => {
  it("is an instance of Error", () => {
    const err = new OrderNotFoundError("ORD-999");
    expect(err).toBeInstanceOf(Error);
  });

  it("has the correct error code", () => {
    const err = new OrderNotFoundError("ORD-999");
    expect(err.code).toBe("ORDER_NOT_FOUND");
  });

  it("includes the orderId in the message", () => {
    const err = new OrderNotFoundError("ORD-999");
    expect(err.message).toContain("ORD-999");
  });

  it("can be caught as a generic Error", () => {
    expect(() => {
      throw new OrderNotFoundError("ORD-001");
    }).toThrowError("ORD-001");
  });
});

describe("InvalidStateError", () => {
  it("is an instance of Error", () => {
    const err = new InvalidStateError("Cannot process");
    expect(err).toBeInstanceOf(Error);
  });

  it("has the correct error code", () => {
    const err = new InvalidStateError("Cannot process");
    expect(err.code).toBe("INVALID_STATE");
  });

  it("preserves the custom message", () => {
    const msg = "Order is in fulfilled state — cannot retry";
    const err = new InvalidStateError(msg);
    expect(err.message).toBe(msg);
  });
});

describe("InventoryUnavailableError", () => {
  it("is an instance of Error", () => {
    const err = new InventoryUnavailableError("ORD-042");
    expect(err).toBeInstanceOf(Error);
  });

  it("has the correct error code", () => {
    const err = new InventoryUnavailableError("ORD-042");
    expect(err.code).toBe("INVENTORY_UNAVAILABLE");
  });

  it("includes the orderId in the message", () => {
    const err = new InventoryUnavailableError("ORD-042");
    expect(err.message).toContain("ORD-042");
    expect(err.message).toContain("inventory unavailable");
  });
});
