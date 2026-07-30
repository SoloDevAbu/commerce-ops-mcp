import {
  OrderNotFoundError,
  InvalidStateError,
  InventoryUnavailableError,
} from "../types";

export { OrderNotFoundError, InvalidStateError, InventoryUnavailableError };

/**
 * Converts any caught error into a human-readable MCP error string.
 * Provides actionable suggestions so the AI can guide the operator.
 */
export function formatMcpError(error: unknown): string {
  if (error instanceof OrderNotFoundError) {
    return (
      `Order not found: ${error.message}. ` +
      `Verify the order ID is correct (e.g., ORD-1047) and use ` +
      `commerce_list_pending_investigations to browse existing orders.`
    );
  }

  if (error instanceof InvalidStateError) {
    return (
      `Invalid operation: ${error.message}. ` +
      `Use commerce_investigate_order to check the current order state before retrying.`
    );
  }

  if (error instanceof InventoryUnavailableError) {
    return (
      `${error.message}. ` +
      `Consider using commerce_update_order_status to cancel the order or wait for inventory restock.`
    );
  }

  if (error instanceof Error) {
    return `Unexpected error: ${error.message}`;
  }

  return `Unexpected error: ${String(error)}`;
}
