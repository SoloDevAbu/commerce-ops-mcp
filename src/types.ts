export type EvidenceItem = {
  label: string;
  status: "pass" | "fail" | "unknown";
  detail?: string;
};

export type InvestigationReport = {
  orderId: string;
  summary: string;
  rootCause: string;
  evidence: EvidenceItem[];
  timeline: TimelineEvent[];
  confidence: "high" | "medium" | "low";
  recommendedNextStep: string;
  riskLevel: "low" | "medium" | "high";
  // Signals whether the recommended action could be safely automated in production.
  automationEligible: boolean;
};

export type TimelineEvent = {
  timestamp: string;
  eventType: string;
  description: string;
};

export type IssueCategory =
  | "payment_mismatch"
  | "fulfillment_failure"
  | "stuck_processing"
  | "fulfillment_delay";

export type PendingInvestigation = {
  orderId: string;
  issueCategory: IssueCategory;
  issueSummary: string;
  amount: number;
  currency: string;
  customerEmail: string;
  stuckSinceHours: number | null;
  createdAt: string;
};

export type OperationsSummary = {
  generatedAt: string;
  periodHours: number;
  totalOrders: number;
  ordersNeedingAttention: number;
  byIssueCategory: Record<IssueCategory, number>;
  recentAuditActions: AuditEntry[];
};

export type AuditEntry = {
  id: string;
  orderId: string;
  action: string;
  reason: string;
  outcome: string;
  performedAt: string;
};

export type RetryResult =
  | {
      confirmed: false;
      orderId: string;
      validationPassed: boolean;
      message: string;
    }
  | {
      confirmed: true;
      success: boolean;
      orderId: string;
      message: string;
      newStatus: string;
      auditId: string;
    };

export type StatusUpdateResult =
  | {
      dryRun: true;
      orderId: string;
      currentStatus: string;
      proposedStatus: string;
      impact: string;
      riskLevel: "low" | "medium" | "high";
    }
  | {
      dryRun: false;
      success: boolean;
      orderId: string;
      previousStatus: string;
      newStatus: string;
      auditId: string;
    };

export class OrderNotFoundError extends Error {
  readonly code = "ORDER_NOT_FOUND";
  constructor(orderId: string) {
    super(`Order ${orderId} does not exist`);
  }
}

export class InvalidStateError extends Error {
  readonly code = "INVALID_STATE";
  constructor(message: string) {
    super(message);
  }
}

export class InventoryUnavailableError extends Error {
  readonly code = "INVENTORY_UNAVAILABLE";
  constructor(orderId: string) {
    super(`Cannot fulfill order ${orderId}: inventory unavailable`);
  }
}

export class ApprovalRequiredError extends Error {
  readonly code = "APPROVAL_REQUIRED";
  constructor() {
    super(
      "This operation requires explicit approval. " +
        "Set confirmed=true after obtaining human confirmation.",
    );
  }
}
