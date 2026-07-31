# Commerce Ops MCP Server

An AI-native **Model Context Protocol (MCP) server** for commerce operations. Instead of exposing low-level CRUD APIs, it exposes **business capabilities** -- allowing Claude to investigate stuck orders, explain root causes, and execute recovery actions after human approval.

> **Note:** For a detailed breakdown of the product choices and technical assumptions behind this project, please read the [Product Decisions](PRODUCT_DECISIONS.md). To see how AI was used during development, check the [AI Worklog](AI_WORKLOG.md).

---

## MCP Tools

| Tool | Type | Description |
|------|------|-------------|
| `commerce_investigate_order` | Read-only | Full investigation of a single order -- root cause, evidence, timeline, recommendation |
| `commerce_list_pending_investigations` | Read-only | All orders needing attention, grouped by issue category and sorted by severity |
| `commerce_get_operations_summary` | Read-only | Aggregate metrics + recent audit trail for a configurable time window |
| `commerce_retry_fulfillment_processing` | Write | Re-submits a failed/stuck order to the fulfillment pipeline (human approval required) |
| `commerce_update_order_status` | Write | Manual status override with dry-run preview + audit trail (human approval required) |

---

## Connecting to Claude

There are two ways to connect this MCP server to Claude: using the **hosted deployment** (no local setup required) or running it **locally** from source.

---

### Option A -- Hosted MCP (Recommended, no setup required)

The server is deployed on Railway and accessible over HTTP. You can connect it to Claude without installing anything.

**Hosted MCP URL:**
```
https://commerce-ops-mcp-production.up.railway.app/mcp
```

#### Connect via Claude.ai (web)

1. Open [claude.ai](https://claude.ai) and sign in.
2. Click your profile icon -> **Settings**.
3. Go to the **Connectors** tab.
4. Click **Add custom connector** (or **Add integration**).
5. Paste the hosted MCP URL into the URL field:
   ```
   https://commerce-ops-mcp-production.up.railway.app/mcp
   ```
6. Save. The five commerce tools will appear in your next conversation.

#### Connect via Claude Desktop (hosted URL)

You can also point Claude Desktop at the hosted URL instead of running the server locally. Open your Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add the following entry inside `"mcpServers"`:

```json
{
  "mcpServers": {
    "commerce-ops": {
      "type": "http",
      "url": "https://commerce-ops-mcp-production.up.railway.app/mcp"
    }
  }
}
```

Restart Claude Desktop. The tools will be available immediately -- no local build or database setup needed.

---

### Option B -- Local Build (Claude Desktop, stdio transport)

Run the server locally as a subprocess connected to Claude Desktop via stdio. This requires Node.js >= 20 and pnpm.

#### 1. Install dependencies

```bash
pnpm install
```

#### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set your Neon Postgres connection string:

```
DATABASE_URL=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require
```

Create a free Neon project at [neon.tech](https://neon.tech) if you do not have one.

#### 3. Push the database schema

```bash
pnpm db:push
```

#### 4. Seed synthetic order data

```bash
pnpm seed
```

This inserts 10 realistic order scenarios (ORD-1001 through ORD-1010) into the database.

#### 5. Build the server

```bash
pnpm build
```

The compiled output is written to `dist/`.

#### 6. Configure Claude Desktop

Open your Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Navigate to: **Claude Desktop -> Settings -> Developer -> Edit Config**

Add the following entry inside `"mcpServers"`, replacing the path with the absolute path to your local clone:

```json
{
  "mcpServers": {
    "commerce-ops": {
      "command": "node",
      "args": ["/absolute/path/to/commerce-ops-mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require"
      }
    }
  }
}
```

Restart Claude Desktop. Claude will launch the server as a subprocess on startup.

---

## Synthetic Scenarios

The seed data covers 10 representative order scenarios:

| Order | Scenario | Issue Category |
|-------|----------|----------------|
| ORD-1001 | Fully fulfilled -- happy path | None |
| ORD-1002 | Payment captured, fulfillment never started | `fulfillment_failure` |
| ORD-1003 | Inventory unavailable | `fulfillment_failure` |
| ORD-1004 | Payment status mismatch | `payment_mismatch` |
| ORD-1005 | Stuck in processing > 6h | `stuck_processing` |
| ORD-1006 | Fulfillment failed (provider timeout) | `fulfillment_failure` |
| ORD-1007 | Duplicate fulfillment event | `stuck_processing` |
| ORD-1008 | Fulfillment delayed (no update for 3h) | `fulfillment_delay` |
| ORD-1009 | Payment never captured | `payment_mismatch` |
| ORD-1010 | Previously failed, successfully retried | None (resolved) |

---

## Example Workflow

**Operator:** "Order ORD-1002 is stuck. Investigate it."

Claude calls `commerce_investigate_order("ORD-1002")` and receives:

```
Investigation Report: ORD-1002

Summary
Payment was captured 6.2 hours ago. Inventory was reserved.
The order has never progressed to fulfillment.

Root Cause
The fulfillment pipeline did not pick up this order after payment capture.

Evidence
- Payment Captured       pass
- Inventory Reserved     pass
- Fulfillment Not Started fail

Confidence: High
Risk Level: Low

Recommended Next Step
Retry fulfillment processing. The payment and inventory state are valid.
```

Claude explains the finding and asks the operator to confirm the retry.

On approval, Claude calls:

```
commerce_retry_fulfillment_processing("ORD-1002", "Fulfillment pipeline missed order after payment capture")
```

The action is recorded in the audit log and the outcome is reported back.

---

## Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm install` | Install all dependencies |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm dev` | Run in watch mode via stdio (local development) |
| `pnpm dev:http` | Run in watch mode via HTTP transport |
| `pnpm start` | Start the compiled server via stdio |
| `pnpm start:http` | Start the compiled server via HTTP |
| `pnpm seed` | Populate the database with 10 synthetic orders |
| `pnpm db:push` | Push Drizzle schema to the database |
| `pnpm db:setup` | Push schema + seed in one step |
| `pnpm test` | Run the test suite |

---

## Project Structure

```
src/
+-- index.ts                     # Server entry point (stdio + HTTP transport)
+-- constants.ts                 # Shared constants (thresholds, limits)
+-- types.ts                     # Domain types (InvestigationReport, etc.)
+-- db/
|   +-- schema.ts                # Drizzle ORM schema (5 tables)
|   +-- client.ts                # Neon Postgres connection
|   +-- index.ts                 # Re-exports
|   +-- seed.ts                  # 10 synthetic order scenarios
+-- mcp/
|   +-- index.ts                 # Tool registration
|   +-- tools/
|       +-- investigate.order.ts
|       +-- list.pending.investigations.ts
|       +-- get.operations.summary.ts
|       +-- retry.fulfillment.ts
|       +-- update.order.status.ts
+-- services/
|   +-- investigation.service.ts # Read-only rule engine -- core product logic
|   +-- operations.service.ts    # Fleet-level views and summaries
|   +-- recovery.service.ts      # State-changing operations (always audited)
+-- lib/
    +-- audit.ts                 # Centralized audit log writer
    +-- date.utils.ts            # Timestamp helpers
    +-- errors.ts                # Error formatting for MCP responses
    +-- format.ts                # Markdown rendering for tool output
```
