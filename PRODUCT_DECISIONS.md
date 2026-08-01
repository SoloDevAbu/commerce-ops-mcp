# Product Decisions, Assumptions & Exclusions

## The problem I chose to focus on

Commerce operations executives currently depend on engineers to answer one
recurring question: *"why is this order stuck, and what do I do about it?"*
Answering it means opening a payments dashboard, a fulfillment dashboard,
and an events log, then manually correlating what's in each.

I scoped this project around collapsing that entire manual correlation
step into one MCP tool call: `commerce_investigate_order`. Everything else in the
system -- the four supporting tools, the schema, the seed data -- exists to
make that one workflow real and demonstrable, not to broaden feature
coverage.

**Target user:** a commerce operations executive, not a developer and not
a customer. This shaped every output format decision below -- reports read
as findings an operator can act on, not as raw API payloads.

## The core workflow

1. Operator asks Claude (or any MCP-connected client): *"Order ORD-1001 is
   stuck, investigate it."*
2. Claude calls `commerce_investigate_order`. The MCP correlates payment,
   fulfillment, and event-history records and returns a structured report:
   summary, root cause, evidence, full timeline, confidence, recommended
   next step, risk level, and whether the fix is safe to automate.
3. If the recommendation requires a state change, Claude explains the
   finding in plain language and asks the operator to confirm.
4. On confirmation, Claude calls `commerce_retry_fulfillment_processing` or
   `commerce_update_order_status`. The action is applied, written to an audit log,
   and the outcome is reported back.

The MCP owns the business reasoning (evidence gathering, root-cause
inference, risk assessment). The AI client owns the conversation and the
approval gate. That split is deliberate -- see "Safety model" below.

## Architecture

```
Operations Executive
        |
        v
  Claude (web, Desktop, or any MCP client)
        |
        v
Hosted MCP Server -- Fastify, Streamable HTTP transport (Railway)
        |  (stdio transport also exposed for local Claude Desktop use)
        v
   MCP Tool Layer         validates input, calls a service, formats output -- no logic
        |
        v
   Service Layer
   +-- investigation.service.ts   read-only rule engine -- this IS the product
   +-- operations.service.ts      read-only fleet-level views and summaries
   +-- recovery.service.ts        state-changing, idempotent, always audited
        |
        v
   Drizzle ORM -> Neon Postgres
```

No repository layer, no controllers, no DTOs. For five tables and ten
seed rows, services calling Drizzle directly is enough -- adding an
indirection layer here would be architecture for its own sake rather than
a signal of engineering judgment.

## Key decisions

### The MCP does reasoning, not just data retrieval

I deliberately did not expose `getOrder()` / `getPayment()` /
`getFulfillment()` as separate tools and leave correlation to the AI
client. `commerce_investigate_order` returns a finished diagnosis -- evidence,
root cause, confidence, recommendation, risk, automation eligibility -- in
one call. This was the central product bet of the assignment: the MCP is
the thing doing the operational thinking, and the AI client's job is to
communicate that thinking and manage the approval step, not to
re-derive it from raw rows.

### Neon Postgres over SQLite

I started this build with SQLite (single file, zero infrastructure to
provision) and switched to Neon Postgres before shipping. The reasoning
changed once I looked at it from a *deployed, evaluator-facing* angle
rather than a *local dev* angle:

- Railway's filesystem for a hobby/free-tier service isn't guaranteed to
  persist across restarts or redeploys. SQLite-as-a-file is only as
  durable as that disk -- a redeploy during evaluation could silently
  reset the seed data.
- Neon is serverless Postgres with zero maintenance from me -- no server
  to patch, no backup schedule to own, and it survives redeploys of the
  Railway service independently, since the data now lives outside the
  compute container entirely.
- Drizzle's query API is identical across both drivers, so nothing about
  the service or tool layer changed -- this was a swap at the `db/client.ts`
  boundary only.

The trade-off I accepted: one more external dependency (Neon) and a
connection string to manage as a Railway environment variable, versus
one less thing that can silently lose state during evaluation. For a
take-home an evaluator will hit cold, I weighted durability over
minimizing moving parts.

### Flat repo, not a monorepo

One deployable service. A monorepo (`apps/` + `packages/`) earns its
complexity when multiple deployables share code -- that's not this
project. I considered it seriously (see AI Worklog) and rejected it: the
workspace config and cross-package build ordering it would add doesn't
buy anything when there's a single Fastify service and no second consumer
of the schema package.

### Rule-based diagnosis, not ML

`investigation.service.ts` is a deterministic, priority-ordered set of rules over
evidence (payment status, provider-vs-internal mismatch, fulfillment
status, timing thresholds). This was a conscious choice over anything
model-based: it's fully explainable (an operator can see exactly why a
recommendation was made), it's unit-testable without mocking a model, and
it matches the assignment's emphasis on MCP design and judgment rather
than feature or ML sophistication.

## Safety model

- **Read-only tools** (`commerce_investigate_order`, `commerce_list_pending_investigations`,
  `commerce_get_operations_summary`) run freely -- they cannot change state.

- **Write tools** (`commerce_retry_fulfillment_processing`, `commerce_update_order_status`)
  enforce approval **server-side at the mutation boundary**, not only through
  client instructions:
  - `commerce_retry_fulfillment_processing` requires `confirmed=true`. When called
    with `confirmed=false` (the default), it runs all eligibility guards and returns
    a validation preview -- no rows are touched. The mutation path only executes when
    `confirmed=true` is explicitly set by the caller.
  - `commerce_update_order_status` requires `dryRun=false` **and** `confirmed=true`.
    `dryRun=true` (the default) returns a preview showing current status, proposed
    status, impact, and risk level. When `dryRun=false` but `confirmed` is still
    `false`, the server throws `ApprovalRequiredError` and writes nothing. This
    guarantee holds regardless of which AI client connects to the server.

- **Idempotency** on write tools is enforced at the database layer, not just
  through input validation:
  - Every write operation generates a deterministic `idempotencyKey`
    (e.g. `retry_fulfillment:ORD-1002`, `update_status:ORD-1002:stuck:processing`)
    and writes it to a unique-constrained column in `audit_log`.
  - If two concurrent calls pass all eligibility guards and both reach the
    `INSERT` into `audit_log`, the second will produce a PostgreSQL unique
    constraint violation (error code `23505`). The service catches this and
    returns the same success shape — so the caller gets a clean result,
    and the database contains exactly one audit row per logical operation.
  - Inside every transaction the order row is re-read with a `FOR UPDATE` row
    lock, preventing a second concurrent call from proceeding past the lock
    until the first transaction commits.

- **State-transition enforcement**: `commerce_update_order_status` validates the
  requested transition against a strict `VALID_TRANSITIONS` map before touching
  any row. Terminal states (`fulfilled`, `cancelled`) have no outbound edges --
  no call can move an order out of a terminal state. The allowed transitions are:

  | From        | To (allowed)                          |
  | ----------- | ------------------------------------- |
  | `pending`   | `processing`, `cancelled`             |
  | `processing`| `stuck`, `fulfilled`, `cancelled`     |
  | `stuck`     | `processing`, `cancelled`             |
  | `fulfilled` | *(terminal — no transitions)*         |
  | `cancelled` | *(terminal — no transitions)*         |

- Every write, whether it succeeds or is rejected after guards pass, appends
  exactly one row to `audit_log` through the single `writeAudit()` function --
  centralized so no future write path can accidentally skip it.

- Every `commerce_investigate_order` report includes `automationEligible`, flagging
  which fixes would be safe to auto-retry in a future iteration --
  without actually building that auto-retry path now. This is a
  deliberately visible seam for "what's next," not a finished feature.

## Assumptions

- One operator at a time; no multi-user auth or role separation. The
  assignment explicitly excludes auth, and a single shared operational
  view matches how a small ops team would actually use this.
- Orders, payments, and fulfillment are one-to-one (enforced via unique
  constraints on `orderId` in both tables) -- no split shipments or partial
  refunds modeled.
- The synthetic payment provider and fulfillment provider are represented
  only as status fields on our own records, not as separate mocked
  services with their own APIs -- sufficient to demonstrate reconciliation
  logic without building two fake external systems.
- Currency is fixed at INR by schema default, reflecting the target
  market implied by the assignment; not exposed as configurable since no
  workflow depends on it.

## Out of scope (explicitly excluded)

- Frontend or dashboard of any kind -- the MCP is the product surface.
- Authentication or user/role management.
- Real payment or fulfillment provider integrations -- all data is
  synthetic and self-created.
- A complete commerce backend (carts, catalog, pricing, promotions).
- Automatic retries without human approval -- `automationEligible` marks
  candidates for this, but execution always requires confirmation in this
  build.
- CI/CD pipelines beyond Railway's own build-on-push.
- Session-stateful MCP transport -- the hosted Streamable HTTP endpoint
  runs in stateless mode (a fresh server + transport per request), which
  is sufficient for a single-operator workload and avoids request-ID
  collisions between concurrent callers without needing session storage.

## Remaining risks / what I'd do next

- The rule engine's thresholds (e.g. the 4-hour "stuck in processing"
  window) are illustrative constants, not tuned against real operational
  data.
- No pagination on `commerce_list_pending_investigations` -- fine at 10 synthetic
  orders, would need it at real scale.
- No rate limiting or auth on the hosted MCP endpoint, acceptable only
  because this is a synthetic-data evaluation deployment, not a
  production one connected to real orders.
- The natural next production step flagged by `automationEligible` would
  be: auto-retry low-risk, high-confidence cases immediately, and only
  route medium/high-risk cases to human approval -- I scoped that out to
  keep this build small and explainable rather than half-building an
  automation policy.
