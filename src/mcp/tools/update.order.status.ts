import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { updateOrderStatus } from "../../services/recovery.service.js";
import { formatMcpError } from "../../lib/errors.js";

import { VALID_ORDER_STATUSES } from "../../constants.js";

export function registerUpdateOrderStatusTool(server: McpServer): void {
  server.registerTool(
    "commerce_update_order_status",
    {
      title: "Update Order Status",
      description: `Manually updates the status of an order. Supports dry-run mode for safe previewing.

STATE-CHANGING OPERATION - always use dry_run=true first, present the impact to the operator, and only call with dry_run=false after explicit human approval.

Use this tool when:
  - An order is stuck and needs to be manually advanced or cancelled
  - The investigation recommends a direct status change
  - You need to cancel an order with a failed payment

Valid statuses:
  - pending    -> Order placed but payment not confirmed
  - processing -> Active order being handled
  - stuck      -> Processing halted with no progress
  - fulfilled  -> Completed delivery (use only after confirming delivery)
  - cancelled  -> Order terminated (triggers refund if payment was captured)

With dry_run=true (default): Returns a preview showing current status, proposed status, expected impact, and risk level. NO changes are made.
With dry_run=false: Executes the status change, records an event in the order timeline, and writes to the audit log.

Args:
  - orderId (string): The order to update
  - newStatus (string): Target status
  - reason (string): Reason for the update (written to audit log)
  - dryRun (boolean, default true): If true, only previews the change without executing it
  - confirmed (boolean, default false): Must be true to execute when dryRun=false

Returns: For dry_run=true - preview with impact and risk. For dry_run=false - confirmation with audit record ID.`,

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
        confirmed: z
          .boolean()
          .default(false)
          .describe(
            "Must be true to execute when dryRun=false. " +
              "The AI client must obtain explicit human approval before setting this to true.",
          ),
      },

      outputSchema: {
        dryRun: z.boolean(),
        success: z.boolean().optional(),
        orderId: z.string(),
        currentStatus: z.string().optional(),
        proposedStatus: z.string().optional(),
        impact: z.string().optional(),
        riskLevel: z.enum(["high", "medium", "low"]).optional(),
        previousStatus: z.string().optional(),
        newStatus: z.string().optional(),
        auditId: z.string().optional(),
      },

      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ orderId, newStatus, reason, dryRun, confirmed }) => {
      try {
        const result = await updateOrderStatus(
          orderId.trim().toUpperCase(),
          newStatus,
          reason,
          dryRun,
          confirmed,
        );

        let text: string;
        if (result.dryRun) {
          text =
            `DRY RUN: No changes made.\n\n` +
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
