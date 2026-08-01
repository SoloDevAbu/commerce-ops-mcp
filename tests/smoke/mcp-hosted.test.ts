/**
 * Hosted MCP Smoke Check
 *
 * Verifies the deployed MCP endpoint is functional by:
 *  1. Initializing a client session over Streamable HTTP
 *  2. Listing all registered tools
 *  3. Calling a read-only tool and verifying the response
 *
 * Run with: pnpm test:smoke
 *
 * Set MCP_HOSTED_URL to override the default endpoint:
 *   MCP_HOSTED_URL=http://localhost:3000/mcp pnpm test:smoke
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_HOSTED_URL ?? "http://localhost:3000/mcp";

const EXPECTED_TOOLS = [
  "commerce_investigate_order",
  "commerce_list_pending_investigations",
  "commerce_get_operations_summary",
  "commerce_retry_fulfillment_processing",
  "commerce_update_order_status",
];

describe("Hosted MCP Smoke Check", () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    client = new Client({ name: "smoke-test-client", version: "1.0.0" });
    await client.connect(transport);
  }, 15_000); // 15s timeout for cold starts

  afterAll(async () => {
    await client?.close();
  });

  it("initializes and lists all 5 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    for (const expected of EXPECTED_TOOLS) {
      expect(names).toContain(expected);
    }
    expect(tools).toHaveLength(5);
  });

  it("calls commerce_get_operations_summary successfully", async () => {
    const result = await client.callTool({
      name: "commerce_get_operations_summary",
      arguments: { periodHours: 48 },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);

    // The response should contain text content with summary information
    const textContent = (
      result.content as Array<{ type: string; text: string }>
    ).find((c) => c.type === "text");
    expect(textContent).toBeDefined();
    expect(textContent!.text).toContain("Operations Summary");
  });

  it("calls commerce_investigate_order for a seeded order", async () => {
    const result = await client.callTool({
      name: "commerce_investigate_order",
      arguments: { orderId: "ORD-1001" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBeDefined();

    const textContent = (
      result.content as Array<{ type: string; text: string }>
    ).find((c) => c.type === "text");
    expect(textContent).toBeDefined();
    expect(textContent!.text).toContain("ORD-1001");
  });

  it("calls commerce_list_pending_investigations successfully", async () => {
    const result = await client.callTool({
      name: "commerce_list_pending_investigations",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBeDefined();
  });
});
