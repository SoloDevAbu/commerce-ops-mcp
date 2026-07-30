import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listPendingInvestigations } from "../services/operations.service";
import { formatPendingInvestigations } from "../lib/format";
import { formatMcpError } from "../lib/errors";
import { DEFAULT_PAGE_LIMIT } from "../constants";

const ISSUE_CATEGORIES = [
  "payment_mismatch",
  "fulfillment_failure",
  "stuck_processing",
  "fulfillment_delay",
] as const;

export function registerPendingTools(server: McpServer): void {
  server.registerTool(
    "commerce_list_pending_investigations",
    {
      title: "List Pending Investigations",
      description: `Returns a list of orders that currently require operational attention, grouped by issue category.

Use this tool to:
  - Get a fleet-level view of open issues before deciding where to focus
  - Find specific order IDs to pass to commerce_investigate_order
  - Filter by a specific issue category (e.g., only show payment mismatches)

Results are sorted by severity: payment mismatches first (highest risk), then stuck orders, fulfillment failures, and delays last.

Issue categories:
  - payment_mismatch: Internal and provider payment statuses differ, or payment is still pending
  - fulfillment_failure: Fulfillment pipeline failed or never started despite captured payment
  - stuck_processing: Order is in processing state with no progress beyond the expected time threshold
  - fulfillment_delay: Fulfillment is in progress but no update received from the delivery partner

Args:
  - limit (number, default 20): Maximum orders to return
  - issueCategory (optional): Filter to a specific issue category

Returns: Grouped list of pending investigations with order IDs, customer emails, amounts, and issue summaries.`,

      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(DEFAULT_PAGE_LIMIT)
          .describe("Maximum number of orders to return (default: 20)"),
        issueCategory: z
          .enum(ISSUE_CATEGORIES)
          .optional()
          .describe(
            "Filter to a specific issue category. Omit to return all pending investigations."
          ),
      },

      outputSchema: {
        count: z.number(),
        items: z.array(
          z.object({
            orderId: z.string(),
            customerEmail: z.string(),
            amount: z.number(),
            currency: z.string(),
            issueCategory: z.enum(["payment_mismatch", "fulfillment_failure", "stuck_processing", "fulfillment_delay"]),
            issueSummary: z.string(),
            stuckSince: z.string().nullable().optional(),
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
    async ({ limit, issueCategory }) => {
      try {
        const items = await listPendingInvestigations({ limit, issueCategory });
        return {
          content: [
            {
              type: "text",
              text: formatPendingInvestigations(items),
            },
          ],
          structuredContent: { count: items.length, items },
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
