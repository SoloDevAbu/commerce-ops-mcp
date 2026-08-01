# AI Worklog

This document outlines how AI was leveraged to accelerate planning, implementation, and verification, while ensuring architectural ownership and product quality remained strictly human-driven.

## 1. Tools and Models Used

| Stage | Tool | Model | Rationale |
| :--- | :--- | :--- | :--- |
| Planning & architecture decisions | Claude (web) | Sonnet 5, extended thinking | Needed a model that could reason through trade-offs (monorepo vs. flat, SQLite vs. managed Postgres) rather than just pattern-match to a template. Thinking mode surfaced the actual trade-offs instead of a single confident answer. |
| Scaffolding & implementation | Antigravity (Pro) | Sonnet 4.6, thinking | Best model available to me in that environment for sustained, multi-file TypeScript generation with direct file-system access. |
| Cross-verification of architecture calls | Claude (web) + ChatGPT | Sonnet 5 / GPT | When a recommendation felt off, I put the same question to a second model before accepting it, rather than taking one model's word as final. |
| Running the deployed MCP | Claude (web) | Sonnet 5 | The assignment explicitly says not to build a frontend, Claude web already has a working MCP client, so connecting the hosted URL there gave me a real consumer of the tools with zero UI work. |
| Local tool verification | Claude Desktop | — | Used for stdio-transport verification against the same codebase before deploying the HTTP transport, so I had two independent transports validated, not just one. |
| Core-logic verification | Vitest | — | Unit/integration tests against the service layer directly (not through MCP), so business logic correctness didn't depend on the transport working. |

## 2. Development Strategy

I ran the planning phase as an explicit design conversation *before* writing any code. I established the product scope, target user, MCP tool surface, database choice, and repository layout. I deliberately asked the AI for the reasoning behind its recommendations to differentiate between real constraints and default templates.

Once the architecture was settled, I avoided using a single, long-running chat. Instead, I broke the implementation into focused, single-purpose sessions:
1. **Database Layer:** Schema and client configuration.
2. **Core Services:** Implemented one at a time against agreed-upon requirements.
3. **Unit Testing:** Unit tests for core logic using in-memory mocks to stabilize the service layer.
4. **MCP Tool Layer:** Tool definitions, input validation, and shared utilities.
5. **Transports & Deployment:** Fastify HTTP and `stdio` server registration.
6. **Integration Testing & Smoke Checks:** After completing the core project and receiving review feedback, I expanded the test suite to include PostgreSQL-backed integration tests (to verify mutation side-effects and concurrency locking) and a hosted MCP smoke check (to perform initialization, list tools, and call at least one tool over HTTP).

This compartmentalization prevented the AI's context window from degrading, reduced hallucinations, and ensured strict adherence to previously agreed-upon architectural boundaries.

## 3. Division of Responsibility

I maintained absolute ownership over product and architecture decisions. The AI was used to generate options, weigh trade-offs, and produce boilerplate once a decision was finalized. 

I manually reviewed every generated file. If the code worked but failed to meet clean-code standards (e.g., unclear naming, blurred layer boundaries, missing edge cases), I corrected it manually rather than relying on iterative prompting, ensuring deterministic quality control.

## 4. Key Constraints Supplied to the AI

To keep the AI focused, I explicitly enforced the following constraints during generation:
- **Target User:** Operations executives (optimizing for actionable reports, not raw JSON payloads).
- **Architecture over Speed:** Explicit instructions to prioritize clean, maintainable code. This ensured the rule engine remained a pure function, and all audit logging was strictly centralized.
- **Strict Scope Boundaries:** No frontend, no authentication, and no speculative abstraction layers (e.g., controllers, DTOs).
- **Best Practices:** Provided structured skill files (`mcp-builder`, `fastify-best-practices`) to force adherence to the latest ecosystem standards rather than relying on stale baseline training data.

## 5. AI Suggestions Rejected or Modified

**1. Monorepo vs. Flat Repo:** 
The AI initially recommended an `apps/` + `packages/` monorepo split to "naturally separate concerns." **I rejected this.** There is exactly one deployable service. A workspace split introduces build complexity that only pays off with multiple deployables or shared code consumers.

**2. Database Choice:** 
The AI recommended SQLite for zero-infrastructure local simplicity. While excellent for local dev, **I rejected it for the deployed target.** The host environment (Railway) does not guarantee disk persistence across ephemeral container restarts, risking silent data loss during evaluation. I forced a pivot to Neon Postgres (Serverless) to guarantee state durability, updating the Drizzle driver and connection logic while keeping the underlying schema intact.

## 6. Verification & Testing

AI-generated code was heavily scrutinized using a multi-layered testing strategy, specifically designed to prove the safety and idempotency of the mutation boundaries:

- **Unit Tests (Vitest):** Tests the service layer directly, covering every branch of the diagnostic rule engine using in-memory mocks. Run via `pnpm test`.
- **PostgreSQL-Backed Integration Tests:** Added recently based on review feedback. Runs against a real Neon Postgres instance, utilizing `seedTestOrder()` and truncating tables between runs. This specifically verifies:
  - **Mutation Side Effects:** Validates atomic updates to orders, fulfillment, and events.
  - **Approval Enforcement:** Proves that missing `confirmed=true` blocks execution (`ApprovalRequiredError`).
  - **Idempotency & Concurrency:** Proves that concurrent retries (`Promise.allSettled`) are safely handled via `FOR UPDATE` row locking, ensuring exactly one audit row is written.
  - **Valid Transitions:** Ensures terminal states cannot be mutated.
  - **Audit Integrity:** Validates that every write generates a permanent, accurate audit log entry.
- **Hosted MCP Smoke Check:** Added alongside integration tests to connect to the deployed `Streamable HTTP` endpoint, perform MCP initialization, list all registered tools, and successfully call at least one tool against the hosted endpoint.
- **Client Verification:** Verified locally via Claude Desktop (`stdio`) and remotely via Claude.ai (`HTTP`) to ensure real-world compatibility.

## 7. Remaining Risks & Unfinished Work
- **Threshold Tuning:** The 4-hour "stuck" window is an illustrative constant and needs tuning against real operational data.
- **Pagination:** Missing on pending investigations; necessary for production scale.
- **Security:** The hosted endpoint currently lacks authentication and rate limiting, which is acceptable for a synthetic evaluation deployment but not for production.
- **Automation Pipeline:** The `automationEligible` flag successfully identifies safe auto-retries, but the actual cron/event loop to execute them automatically was deliberately excluded to stay within the assignment scope.
