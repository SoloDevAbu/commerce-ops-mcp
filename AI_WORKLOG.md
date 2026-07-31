# AI Worklog

## Tools and models used, and why

| Stage                                    | Tool                   | Model                       | Why this one                                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planning & architecture decisions        | Claude (web)           | Sonnet 5, extended thinking | Needed a model that could reason through trade-offs (monorepo vs. flat, SQLite vs. managed Postgres) rather than just pattern-match to a template. Thinking mode surfaced the actual trade-offs instead of a single confident answer. |
| Scaffolding & implementation             | Antigravity (Pro)      | Sonnet 4.6, thinking        | Best model available to me in that environment for sustained, multi-file TypeScript generation with direct file-system access.                                                                                                        |
| Cross-verification of architecture calls | Claude (web) + ChatGPT | Sonnet 5 / GPT              | When a recommendation felt off, I put the same question to a second model before accepting it, rather than taking one model's word as final.                                                                                          |
| Running the deployed MCP                 | Claude (web)           | Sonnet 5                    | The assignment explicitly says not to build a frontend, Claude web already has a working MCP client, so connecting the hosted URL there gave me a real consumer of the tools with zero UI work.                                       |
| Local tool verification                  | Claude Desktop         | —                           | Used for stdio-transport verification against the same codebase before deploying the HTTP transport, so I had two independent transports validated, not just one.                                                                     |
| Core-logic verification                  | Vitest                 | —                           | Unit/integration tests against the service layer directly (not through MCP), so business logic correctness didn't depend on the transport working.                                                                                    |

## How I used AI to plan and break down the work

I ran the planning phase as an explicit design conversation before any
code: product scope, target user, MCP tool surface, database choice, and
repo layout, in that order. I deliberately asked for the reasoning behind
each recommendation, not just the recommendation, so I could tell the
difference between "this is a real constraint" and "this is a default
template answer."

Once the architecture was settled, I broke implementation into separate,
single-purpose chats rather than one long running conversation:

1. Database layer — schema and client only.
2. Core services, one at a time, against the requirements already agreed
   in planning.
3. Tests for the core service logic, once the services were stable.
4. MCP tool layer and shared lib files.
5. MCP server export/registration.
6. Fastify HTTP transport (hosted) and stdio transport (Claude Desktop).

The reasoning for splitting this way: a single long-running chat
accumulates irrelevant context, and I found that increased the odds of
the model quietly drifting from earlier decisions or inventing details
that weren't there. Scoping each chat to one layer kept the context
window relevant to the file actually being written, and made it obvious
when an output didn't match what had already been built (nothing to
cross-reference against a huge prior transcript).

## Division of responsibility

I owned every product and architecture decision - the workflow to build,
the tool surface, the database choice, the repo shape, what to exclude.
AI tools were used to (a) generate options and trade-offs for me to
decide between, and (b) produce the implementation once a decision was
made. I did not accept a first-pass architectural recommendation without
asking for the reasoning behind it, and for the two decisions that
mattered most (see below), I deliberately cross-checked one model's
recommendation against another before committing.

I read and manually verified every generated file - service logic,
schema, MCP tool descriptions, transport wiring - rather than reviewing
only the parts that failed to run. Where code worked but didn't meet a
clean-code bar I wanted (unclear naming, logic that belonged in a
different layer, missing edge-case handling), I corrected it myself
rather than re-prompting for a fix, since it was often faster and I could
be certain of the result.

## Important context/instructions I supplied

- The target user (ops executive, not developer/customer) and the single
  workflow to optimize for, stated up front so every downstream decision
  had a fixed reference point.
- An explicit instruction to prioritize industry best practices and clean,
  maintainable code even though this is a scoped take-home - this shaped
  things like keeping the rule engine as a pure, testable function
  separate from I/O, and centralizing all audit-log writes through one
  function instead of writing them ad hoc.
- A constraint to not overbuild: no frontend, no auth, no speculative
  abstraction layers - repeated at each implementation stage so later
  chats didn't quietly reintroduce complexity the planning stage had
  already ruled out.

## AI suggestions I corrected, rejected, or substantially changed

**1. Monorepo vs. flat repo.** One planning pass recommended an
`apps/` + `packages/` monorepo split, reasoning that it "naturally
separates concerns." I rejected this: there is exactly one deployable
service here, and a workspace split only pays for itself with multiple
deployables or multiple consumers of shared code, neither of which apply.
The monorepo suggestion was solving a problem this project doesn't have.

**2. Database choice.** The first recommendation was SQLite, for
zero-infrastructure local simplicity. I initially accepted that reasoning
for local development, but reconsidered it for the _deployed_ target:
Railway's disk for a service like this isn't guaranteed to persist
across restarts, which risked the seed data silently disappearing during
evaluation. I switched to Neon Postgres - serverless, no maintenance
burden on me, and durable independent of the Railway container's own
lifecycle. This was the larger of the two changes: it meant swapping the
Drizzle driver and the connection setup in `db/client.ts`, though the
schema and service layer above it were unaffected since Drizzle's query
API is the same across both.

## How I verified AI-generated work

- **Unit tests (Vitest)** against the service layer directly,
  covering every branch of the diagnosis rule engine (payment/provider
  mismatch, fulfillment failure with and without an inventory cause, the
  stuck-in-processing timeout, and the clean happy path). This verifies business logic correctness
  independent of whether the MCP transport is working.
- **Claude Desktop over stdio** against the same codebase, to confirm the
  tools behave correctly through an actual MCP client, not just through
  direct function calls in tests.
- **Claude web against the hosted Streamable HTTP endpoint**, to confirm
  the deployed transport, CORS configuration, and Neon connection all
  work together in the actual environment evaluators will hit - this is
  the same demonstration used in the Loom recording.
- **Manual code review** of every generated file rather than only the
  parts that failed at runtime - checking that tool descriptions
  accurately state their safety requirements, that write paths are all
  routed through the single audit-logging function, and that layer
  boundaries (tools -> services -> data access) were actually respected
  rather than blurred under time pressure.

## Remaining risks or unfinished work

- Diagnosis thresholds (e.g. the processing-stuck window) are reasonable
  illustrative constants, not tuned against real operational data.
- No pagination on the pending-investigations list - a real constraint
  only at a scale well beyond this synthetic dataset.
- No auth or rate limiting on the hosted endpoint - acceptable for a
  synthetic-data evaluation deployment, not for a production system
  handling real orders.
- The `automationEligible` flag marks which fixes could be safely
  auto-retried without human approval, but that auto-retry path itself is
  intentionally not built - flagged as a natural next step rather than
  something I ran out of time on unexpectedly.
