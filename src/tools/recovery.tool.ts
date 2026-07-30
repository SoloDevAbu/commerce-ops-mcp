import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  retryFulfillmentProcessing,
  updateOrderStatus,
} from "../services/recovery.service";
import { formatMcpError } from "../lib/errors";

const VALID_ORDER_STATUSES = [
  "pending",
  "processing",
  "stuck",
  "fulfilled",
  "cancelled",
] as const;

export function registerRecoveryTools(server: McpServer): void {
  // Tool 1: Retry fulfillment processing
  server.registerTool(
    "commerce_retry_fulfillment_processing",
    {
      title: "Retry Fulfillment Processing",
      description: `Retries the fulfillment pipeline for an order that has failed or never started.

STATE-CHANGING OPERATION — always obtain human approval before calling this tool.

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
        message: z.string().optional(),
        newStatus: z.string().optional(),
        auditId: z.string().optional(),
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

  // Tool 2: Update order status
  server.registerTool(
    "commerce_update_order_status",
    {
      title: "Update Order Status",
      description: `Manually updates the status of an order. Supports dry-run mode for safe previewing.

STATE-CHANGING OPERATION — always use dry_run=true first, present the impact to the operator, and only call with dry_run=false after explicit human approval.

Use this tool when:
  - An order is stuck and needs to be manually advanced or cancelled
  - The investigation recommends a direct status change
  - You need to cancel an order with a failed payment

Valid statuses:
  - pending    → Order placed but payment not confirmed
  - processing → Active order being handled
  - stuck      → Processing halted with no progress
  - fulfilled  → Completed delivery (use only after confirming delivery)
  - cancelled  → Order terminated (triggers refund if payment was captured)

With dry_run=true (default): Returns a preview showing current status, proposed status, expected impact, and risk level. NO changes are made.
With dry_run=false: Executes the status change, records an event in the order timeline, and writes to the audit log.

Args:
  - orderId (string): The order to update
  - newStatus (string): Target status
  - reason (string): Reason for the update (written to audit log)
  - dryRun (boolean, default true): If true, only previews the change without executing it

Returns: For dry_run=true — preview with impact and risk. For dry_run=false — confirmation with audit record ID.`,

      inputSchema: {
        orderId: z
          .string()
          .min(1)
          .describe("The order ID to update, e.g. ORD-1047"),
        newStatus: z
          .enum(VALID_ORDER_STATUSES)
          .describe(
            `Target order status. Valid values: ${VALID_ORDER_STATUSES.join(", ")}`,
          ),
        reason: z
          .string()
          .min(5)
          .max(500)
          .describe("Reason for the status change. Written to the audit log."),
        dryRun: z
          .boolean()
          .default(true)
          .describe(
            "If true (default), returns a preview of the change without executing it. Set to false to actually apply the change.",
          ),
      },

      outputSchema: z.discriminatedUnion("dryRun", [
        z.object({
          dryRun: z.literal(true),
          orderId: z.string(),
          currentStatus: z.string(),
          proposedStatus: z.string(),
          impact: z.string(),
          riskLevel: z.enum(["high", "medium", "low"]),
        }),
        z.object({
          dryRun: z.literal(false),
          success: z.boolean(),
          orderId: z.string(),
          previousStatus: z.string().optional(),
          newStatus: z.string().optional(),
          auditId: z.string().optional(),
        }),
      ]),

      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ orderId, newStatus, reason, dryRun }) => {
      try {
        const result = await updateOrderStatus(
          orderId.trim().toUpperCase(),
          newStatus,
          reason,
          dryRun,
        );

        let text: string;
        if (result.dryRun) {
          text =
            `DRY RUN — No changes made.\n\n` +
            `Order: ${result.orderId}\n` +
            `Current Status: ${result.currentStatus}\n` +
            `Proposed Status: ${result.proposedStatus}\n` +
            `Risk Level: ${result.riskLevel.toUpperCase()}\n\n` +
            `Impact: ${result.impact}\n\n` +
            `To apply this change, call this tool again with dryRun=false.`;
        } else if (result.success) {
          text =
            `Order status updated successfully.\n\n` +
            `Order: ${result.orderId}\n` +
            `Previous Status: ${result.previousStatus}\n` +
            `New Status: ${result.newStatus}\n` +
            `Audit Record: ${result.auditId}`;
        } else {
          text = `Status update failed for ${result.orderId}.`;
        }

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
