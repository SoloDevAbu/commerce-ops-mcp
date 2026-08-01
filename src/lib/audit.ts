import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Tx } from "../db/client.js";
import { auditLog } from "../db/schema.js";

/**
 * Every state-changing MCP tool (retry_fulfillment_processing,
 * update_order_status) writes exactly one audit row per call, success or
 * failure. Centralizing here means no future write path can accidentally
 * skip the audit trail.

 */
export async function writeAudit(
  params: {
    orderId: string;
    action: string;
    reason: string;
    outcome: string;
    idempotencyKey?: string;
  },
  tx?: Tx,
): Promise<void> {
  const client = tx ?? db;
  await client.insert(auditLog).values({
    id: randomUUID(),
    orderId: params.orderId,
    action: params.action,
    reason: params.reason,
    outcome: params.outcome,
    performedAt: new Date().toISOString(),
    idempotencyKey: params.idempotencyKey ?? null,
  });
}
