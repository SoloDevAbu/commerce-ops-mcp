/** Hours before an order in "processing" state is considered stuck. */
export const STUCK_THRESHOLD_HOURS = 4;

/** Hours before a fulfillment still in "processing" is flagged as delayed. */
export const FULFILLMENT_DELAY_THRESHOLD_HOURS = 2;

/** Default look-back window (hours) for the operations summary. */
export const DEFAULT_PERIOD_HOURS = 24;

export const MCP_SERVER_NAME = "commerce-ops-mcp-server";
export const MCP_SERVER_VERSION = "1.0.0";

/** Maximum characters in a single MCP tool response before truncation. */
export const CHARACTER_LIMIT = 25_000;

/** Default page size for list tools. */
export const DEFAULT_PAGE_LIMIT = 20;

/**
 * Strict order status transition map.
 * Terminal states (fulfilled, cancelled) have no outbound transitions.
 * Enforced at the service boundary in updateOrderStatus().
 */
export const VALID_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["processing", "cancelled"],
  processing: ["stuck", "fulfilled", "cancelled"],
  stuck: ["processing", "cancelled"],
  fulfilled: [], // terminal
  cancelled: [], // terminal
};
