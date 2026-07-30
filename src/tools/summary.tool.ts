import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getOperationsSummary } from "../services/operations.service";
import { formatOperationsSummary } from "../lib/format";
import { formatMcpError } from "../lib/errors";
import { DEFAULT_PERIOD_HOURS } from "../constants";

export function registerSummaryTools(server: McpServer): void {
  server.registerTool(
    "commerce_get_operations_summary",
    {
      title: "Get Operations Summary",
      description: `Returns an aggregate operational overview for a configurable time window.

Use this tool to:
  - Get a high-level health check of the commerce operation
  - See order volumes, attention counts, and breakdown by issue category
  - Review recent operational actions taken through the MCP (audit trail)
  - Start a shift-handover or standup briefing

The summary includes:
  - Total orders created in the period
  - Count of orders currently needing attention (all issue categories)
  - Breakdown by issue category (payment_mismatch, fulfillment_failure, stuck_processing, fulfillment_delay)
  - Last 10 operational actions from the audit log

Args:
  - periodHours (number, default 24): Look-back window in hours for counting orders and audit records

Returns: Operational metrics with attention breakdown and recent audit trail.`,

      inputSchema: {
        periodHours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .default(DEFAULT_PERIOD_HOURS)
          .describe(
            "How many hours back to look for orders and audit events (default: 24, max: 168 = 7 days)"
          ),
      },

      outputSchema: {
        periodHours: z.number(),
        totalOrders: z.number(),
        ordersNeedingAttention: z.number(),
        byCategory: z.object({
          payment_mismatch: z.number(),
          fulfillment_failure: z.number(),
          stuck_processing: z.number(),
          fulfillment_delay: z.number(),
        }),
        recentActions: z.array(
          z.object({
            orderId: z.string(),
            action: z.string(),
            reason: z.string(),
            outcome: z.string(),
            performedAt: z.string(),
          }),
        ),
      },

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ periodHours }) => {
      try {
        const summary = await getOperationsSummary(periodHours);
        return {
          content: [
            {
              type: "text",
              text: formatOperationsSummary(summary),
            },
          ],
          structuredContent: summary,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: formatMcpError(error) }],
        };
      }
    }
  );
}
