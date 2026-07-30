import type {
  InvestigationReport,
  EvidenceItem,
  TimelineEvent,
  PendingInvestigation,
  OperationsSummary,
  AuditEntry,
} from "../types.js";

function evidenceIcon(status: EvidenceItem["status"]): string {
  switch (status) {
    case "pass":
      return "✓";
    case "fail":
      return "✗";
    default:
      return "?";
  }
}

export function formatEvidence(items: EvidenceItem[]): string {
  return items
    .map((item) => {
      const icon = evidenceIcon(item.status);
      const detail = item.detail ? ` — ${item.detail}` : "";
      return `${icon} ${item.label}${detail}`;
    })
    .join("\n");
}

export function formatTimeline(events: TimelineEvent[]): string {
  if (events.length === 0) return "No events recorded.";
  return events
    .map((e) => {
      const ts = new Date(e.timestamp).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "medium",
      });
      return `[${ts}] ${e.eventType}: ${e.description}`;
    })
    .join("\n");
}

export function formatInvestigationReport(report: InvestigationReport): string {
  const confidenceLabel =
    report.confidence.charAt(0).toUpperCase() + report.confidence.slice(1);
  const riskLabel =
    report.riskLevel.charAt(0).toUpperCase() + report.riskLevel.slice(1);
  const automationLabel = report.automationEligible
    ? "Yes — this action can be safely automated"
    : "No — human approval required";

  return [
    `# Investigation Report: ${report.orderId}`,
    "",
    "## Summary",
    report.summary,
    "",
    "## Root Cause",
    report.rootCause,
    "",
    "## Evidence",
    formatEvidence(report.evidence),
    "",
    "## Timeline",
    formatTimeline(report.timeline),
    "",
    `## Confidence: ${confidenceLabel}`,
    "",
    `## Risk Level: ${riskLabel}`,
    "",
    "## Recommended Next Step",
    report.recommendedNextStep,
    "",
    `## Automation Eligible: ${automationLabel}`,
  ].join("\n");
}

const CATEGORY_LABELS: Record<string, string> = {
  payment_mismatch: "Payment Mismatch",
  fulfillment_failure: "Fulfillment Failure",
  stuck_processing: "Stuck Processing",
  fulfillment_delay: "Fulfillment Delay",
};

export function formatPendingInvestigations(
  items: PendingInvestigation[],
): string {
  if (items.length === 0) {
    return "✓ No orders currently require attention. Operations are running smoothly.";
  }

  // Group by issue category
  const grouped = items.reduce<Record<string, PendingInvestigation[]>>(
    (acc, item) => {
      const cat = item.issueCategory;
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(item);
      return acc;
    },
    {},
  );

  const sections: string[] = [
    `# Pending Investigations (${items.length} orders)`,
    "",
  ];

  for (const [category, orders] of Object.entries(grouped)) {
    const label = CATEGORY_LABELS[category] ?? category;
    sections.push(`## ${label} (${orders.length})`);
    sections.push("");

    for (const order of orders) {
      const stuck =
        order.stuckSinceHours != null
          ? ` | Stuck ${order.stuckSinceHours.toFixed(1)}h`
          : "";
      sections.push(
        `- **${order.orderId}** — ${order.customerEmail} — ` +
          `${order.currency} ${order.amount.toFixed(2)}${stuck}`,
      );
      sections.push(`  ${order.issueSummary}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

export function formatAuditEntry(entry: AuditEntry): string {
  const ts = new Date(entry.performedAt).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `- [${ts}] **${entry.orderId}** — ${entry.action}: ${entry.outcome}`;
}

export function formatOperationsSummary(summary: OperationsSummary): string {
  const lines: string[] = [
    `# Operations Summary (Last ${summary.periodHours}h)`,
    `_Generated at ${new Date(summary.generatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}_`,
    "",
    `## Metrics`,
    `- **Total Orders**: ${summary.totalOrders}`,
    `- **Needing Attention**: ${summary.ordersNeedingAttention}`,
    "",
    "## By Issue Category",
  ];

  for (const [cat, count] of Object.entries(summary.byIssueCategory)) {
    const label = CATEGORY_LABELS[cat] ?? cat;
    lines.push(`- **${label}**: ${count}`);
  }

  lines.push("");
  lines.push("## Recent Audit Actions");

  if (summary.recentAuditActions.length === 0) {
    lines.push("No recent actions recorded.");
  } else {
    for (const entry of summary.recentAuditActions) {
      lines.push(formatAuditEntry(entry));
    }
  }

  return lines.join("\n");
}
