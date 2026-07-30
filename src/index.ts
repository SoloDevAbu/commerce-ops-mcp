#!/usr/bin/env node
/**
 * Commerce Ops MCP Server — Entry Point
 *
 * Supports two transports, selected via the TRANSPORT environment variable:
 *
 *   TRANSPORT=stdio (default)
 *     Runs as a stdio subprocess. Use for local Claude Desktop integration.
 *     Connect Claude Desktop with:
 *       { "command": "node", "args": ["dist/index.js"] }
 *
 *   TRANSPORT=http
 *     Runs as a Fastify HTTP server exposing POST /mcp.
 *     Use for remote/hosted deployments.
 *     Connect Claude with:
 *       { "type": "http", "url": "https://your-host/mcp" }
 *
 * Tools registered:
 *   commerce_investigate_order
 *   commerce_list_pending_investigations
 *   commerce_retry_fulfillment_processing
 *   commerce_update_order_status
 *   commerce_get_operations_summary
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify from "fastify";
import cors from "@fastify/cors";

import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./constants";
import { registerInvestigateTools } from "./tools/investigate.tool";
import { registerPendingTools } from "./tools/pending.tool";
import { registerRecoveryTools } from "./tools/recovery.tool";
import { registerSummaryTools } from "./tools/summary.tool";

// ──────────────────────────────────────────────────────────────────────────────
// Create and configure the MCP server
// ──────────────────────────────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });

  registerInvestigateTools(server);
  registerPendingTools(server);
  registerRecoveryTools(server);
  registerSummaryTools(server);

  return server;
}

// ──────────────────────────────────────────────────────────────────────────────
// stdio transport — for local Claude Desktop use
// ──────────────────────────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is reserved for MCP protocol messages
  process.stderr.write(`[${MCP_SERVER_NAME}] Running via stdio transport\n`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Streamable HTTP transport — for hosted/remote deployments
// ──────────────────────────────────────────────────────────────────────────────

async function runHttp(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const host = process.env.HOST ?? "0.0.0.0";

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? "*",
    methods: ["GET", "POST", "OPTIONS"],
  });

  // Health check endpoint
  app.get("/health", async () => ({
    status: "ok",
    server: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    timestamp: new Date().toISOString(),
  }));

  // MCP endpoint — creates a fresh stateless transport per request
  app.post("/mcp", async (request, reply) => {
    const server = createMcpServer();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
      enableJsonResponse: true,
    });

    reply.raw.on("close", () => {
      transport.close().catch(() => void 0);
    });

    await server.connect(transport);

    // Pass the raw Node.js request/response to the MCP transport
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  await app.listen({ port, host });
  app.log.info(
    `[${MCP_SERVER_NAME}] HTTP transport listening on http://${host}:${port}/mcp`
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Transport selector
// ──────────────────────────────────────────────────────────────────────────────

const transport = (process.env.TRANSPORT ?? "stdio").toLowerCase();

if (transport === "http") {
  runHttp().catch((err: unknown) => {
    console.error("[commerce-ops-mcp] HTTP server error:", err);
    process.exit(1);
  });
} else {
  runStdio().catch((err: unknown) => {
    console.error("[commerce-ops-mcp] stdio error:", err);
    process.exit(1);
  });
}
