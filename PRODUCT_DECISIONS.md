# Product & Architectural Decisions

## 1. Project Scope & Objective

Commerce operations executives typically rely on engineers to correlate data across payments, fulfillment, and event dashboards to diagnose stuck orders.

This project collapses that manual workflow into a single, AI-driven Model Context Protocol (MCP) tool call: `commerce_investigate_order`. The entire system—schema, supporting tools, and seed data—exists solely to demonstrate this specific operational workflow.

**Target User:** Operations executives. Output formats prioritize actionable insights over raw data payloads.

## 2. Core Workflow & Separation of Concerns

1. **Trigger:** Operator asks the MCP client to investigate a stuck order.
2. **Analysis:** The MCP correlates records and returns a structured diagnosis (root cause, evidence, risk level, recommended action).
3. **Approval:** The AI client explains the finding in plain language and requests human confirmation.
4. **Execution:** Upon confirmation, the MCP executes the state-changing action, logs it, and reports the outcome.

**Key Principle:** The MCP server owns the business reasoning (diagnosis, risk assessment). The AI client owns the conversation and the approval gate.

## 3. Architecture

**Tech Stack:** Fastify (MCP Server), Drizzle ORM, Neon Postgres.

- **Topology:** Single deployable service. A monorepo was evaluated but rejected, as there is no shared code across multiple deployables to justify the overhead.
- **Layering:** Flat structure. MCP Tool Layer (input validation/formatting) → Service Layer (read-only rules, idempotent writes) → Database. The architecture excludes unnecessary abstractions (e.g., repository layers, controllers, DTOs) to favor simplicity for a constrained domain.

## 4. Key Design Decisions

### The MCP as the Reasoning Engine

Instead of providing primitive CRUD tools (e.g., `getOrder`, `getPayment`) and relying on the LLM to correlate them, `commerce_investigate_order` returns a fully formed diagnosis. This was the central product bet: the MCP guarantees deterministic business logic, while the AI's job is to communicate that reasoning and manage the approval step, rather than re-deriving it from raw database rows.

### Neon Postgres over SQLite

While SQLite minimizes initial moving parts, Neon Postgres was chosen to ensure data durability across ephemeral host (Railway) redeploys. For an evaluator-facing project, a reliable state that survives container restarts outweighs the minor cost of managing an external dependency and connection string.

### Rule-Based Diagnosis over ML

Root cause analysis uses deterministic, priority-ordered rules rather than Machine Learning models. This guarantees explainability (operators see exactly why a recommendation was made), allows standard unit testing, and focuses the project on MCP design rather than algorithmic complexity.

## 5. Safety & Concurrency Model

- **Strict Server-Side Approval:** Write operations (`commerce_retry_fulfillment_processing`, `commerce_update_order_status`) strictly enforce a `confirmed=true` parameter at the mutation boundary. Defaulting to `false` returns a safe dry-run preview. If `confirmed` is omitted or false during execution, the server throws an `ApprovalRequiredError`. This guarantees safety regardless of the AI client's behavior.
- **Database-Level Idempotency:** Concurrent requests are safely handled at the database level. Every write appends a deterministic `idempotencyKey` to the `audit_log` with a unique constraint. Inside transactions, `FOR UPDATE` row locks prevent race conditions. Duplicate calls fail gracefully with a unique constraint violation and return the original success state, ensuring exactly one audit row per logical operation.
- **State Transition Enforcement:** The service validates actions against a strict `VALID_TRANSITIONS` state machine. Terminal states (`fulfilled`, `cancelled`) have no outbound edges, completely blocking impossible state changes.
- **Immutable Auditing:** All mutations pass through a centralized `writeAudit()` function. No future write path can bypass this, guaranteeing a permanent trail of the action, reason, and outcome.
- **Automation Preparedness:** Reports include an `automationEligible` flag to mark fixes that would be safe to auto-retry in a future iteration, creating a visible seam for future automation without building the actual policy yet.

## 6. Assumptions & Exclusions

- **Scope Assumptions:**
  - Single-operator concurrency (no multi-user auth/roles).
  - 1:1 relationships between orders, payments, and fulfillment (no split shipments or partial refunds).
  - Fixed currency (INR).
- **Out of Scope:**
  - Frontend UI/dashboards (the MCP is the product surface).
  - Authentication and role management.
  - Real payment/fulfillment integrations (mocked via synthetic statuses).
  - Automated execution without human approval.
  - Session-stateful MCP transport (stateless design avoids request-ID collisions).

## 7. Future Considerations

- **Pagination:** Required for `commerce_list_pending_investigations` at real scale.
- **Tuning:** Rule engine thresholds (e.g., 4-hour "stuck" window) require tuning against real operational data.
- **Automation Policy:** Build the execution pipeline to instantly auto-retry `automationEligible` (low-risk, high-confidence) cases while still routing medium/high-risk cases to a human operator.
