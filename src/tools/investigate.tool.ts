import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { investigateOrder } from "../services/investigation.service";
import { formatInvestigationReport } from "../lib/format";
import { formatMcpError } from "../lib/errors";

export function registerInvestigateTools(server: McpServer): void {
  server.registerTool(
    "commerce_investigate_order",
    {
      title: "Investigate Order",
      description: `Performs a complete investigation of a commerce order and returns a structured report.

This is the PRIMARY tool for diagnosing order issues. It correlates data from all internal systems — order records, payment status, fulfillment pipeline, event timeline, and audit history — and returns an investigation report with:
  - A plain-English summary of the current situation
  - Identified root cause
  - Evidence checklist (✓/✗ for each pipeline stage)
  - Full event timeline
  - Confidence level (high/medium/low)
  - Recommended next step
  - Risk level and whether the recommended action is automation-eligible

Covered scenarios:
  - Payment captured but fulfillment never started
  - Fulfillment pipeline failure (provider error, inventory issue)
  - Payment status mismatch between internal records and provider
  - Order stuck in processing beyond the expected threshold
  - Fulfillment delayed (in progress but no updates)
  - Payment never captured (pending timeout)
  - Healthy orders (no action needed)

Args:
  - orderId (string): The order identifier, e.g. "ORD-1047"

Returns: Structured investigation report with summary, root cause, evidence, timeline, confidence, and recommended next step.

Do NOT use this tool to make changes — use commerce_retry_fulfillment_processing or commerce_update_order_status for state changes.`,

      inputSchema: {
        orderId: z
          .string()
          .min(1)
          .describe(
            'The order ID to investigate, e.g. "ORD-1047". Use commerce_list_pending_investigations to discover order IDs.',
          ),
      },

      outputSchema: {
        orderId: z.string(),
        summary: z.string(),
        rootCause: z.string(),
        evidence: z.array(
          z.object({
            label: z.string(),
            status: z.enum(["pass", "fail", "unknown"]),
            detail: z.string().optional(),
          }),
        ),
        timeline: z.array(
          z.object({
            timestamp: z.string(),
            eventType: z.string(),
            description: z.string(),
          }),
        ),
        confidence: z.enum(["high", "medium", "low"]),
        recommendedNextStep: z.string(),
        riskLevel: z.enum(["high", "medium", "low"]),
        automationEligible: z.boolean(),
      },

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ orderId }) => {
      try {
        const report = await investigateOrder(orderId.trim().toUpperCase());
        return {
          content: [
            {
              type: "text",
              text: formatInvestigationReport(report),
            },
          ],
          structuredContent: report,
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
