import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../constants.js";
import { registerInvestigateOrderTool } from "./tools/investigate.order.js";
import { registerListPendingInvestigationsTool } from "./tools/list.pending.investigations.js";
import { registerGetOperationsSummaryTool } from "./tools/get.operations.summary.js";
import { registerRetryFulfillmentTool } from "./tools/retry.fulfillment.js";
import { registerUpdateOrderStatusTool } from "./tools/update.order.status.js";

/**
 * Builds a fresh McpServer with all tools registered. Called once per
 * HTTP request in stateless mode
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });

  // Read-only investigation tools safe for the AI to call without approval.
  registerInvestigateOrderTool(server);
  registerListPendingInvestigationsTool(server);
  registerGetOperationsSummaryTool(server);

  // State-changing operational tools require human approval upstream.
  registerRetryFulfillmentTool(server);
  registerUpdateOrderStatusTool(server);

  return server;
}
