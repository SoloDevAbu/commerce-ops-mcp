import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { retryFulfillmentProcessing } from "../../services/recovery.service.js";
import { formatMcpError } from "../../lib/errors.js";

export function registerRetryFulfillmentTool(server: McpServer): void {
  server.registerTool(
    "commerce_retry_fulfillment_processing",
    {
      title: "Retry Fulfillment Processing",
      description: `Retries the fulfillment pipeline for an order that has failed or never started.

STATE-CHANGING OPERATION - always obtain human approval before calling this tool.

This tool is appropriate when commerce_investigate_order recommends "retry fulfillment processing" as the next step. It will:
  1. Validate that the order is in a retryable state (processing or stuck)
  2. Validate that payment has been captured
  3. Check that the failure is not due to unavailable inventory (which cannot be retried)
  4. Reset the fulfillment record to "processing"
  5. Advance the order status to "processing"
  6. Append a "fulfillment_retried" event to the order timeline
  7. Write a full audit record

Do NOT use this tool when:
  - The investigation report shows an inventory unavailability issue (cancel the order instead)
  - The investigation report shows a payment mismatch (resolve the payment first)
  - The order is already fulfilled or cancelled

Args:
  - orderId (string): The order to retry (e.g., "ORD-1047")
  - reason (string): Human-readable reason for the retry (written to audit log)

Returns: Result object with success status, new order status, and audit record ID.`,

      inputSchema: {
        orderId: z
          .string()
          .min(1)
          .describe("The order ID to retry fulfillment for, e.g. ORD-1047"),
        reason: z
          .string()
          .min(5)
          .max(500)
          .describe(
            "Reason for retrying fulfillment. This is recorded in the audit log.",
          ),
      },

      outputSchema: {
        success: z.boolean(),
        orderId: z.string(),
        message: z.string(),
        newStatus: z.string(),
        auditId: z.string(),
      },

      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ orderId, reason }) => {
      try {
        const result = await retryFulfillmentProcessing(
          orderId.trim().toUpperCase(),
          reason,
        );
        const text = result.success
          ? `Fulfillment retry successful for ${result.orderId}.\n\n` +
            `${result.message}\n\n` +
            `New order status: ${result.newStatus}\n` +
            `Audit record: ${result.auditId}`
          : `Fulfillment retry failed for ${result.orderId}: ${result.message}`;

        return {
          content: [{ type: "text", text }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: formatMcpError(error) }],
        };
      }
    },
  );
}
