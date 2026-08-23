import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { RuntimeTool } from "../runtimes/types.js";
import { customMcpManager, type CustomMcpManager } from "./manager.js";

const NAMESPACE = "custom_mcp";

function schemaShape(schema: Record<string, unknown>): z.ZodRawShape {
  const converted = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  if (converted instanceof z.ZodObject) return converted.shape;
  throw new Error("Custom MCP tool input schemas must describe a JSON object.");
}

function describeBlock(block: CallToolResult["content"][number]): string {
  if (block.type === "text") return block.text;
  if (block.type === "image") {
    return `[image: ${block.mimeType}, ${Buffer.byteLength(block.data, "base64")} bytes]`;
  }
  if (block.type === "audio") {
    return `[audio: ${block.mimeType}, ${Buffer.byteLength(block.data, "base64")} bytes]`;
  }
  if (block.type === "resource_link") {
    return `[resource: ${block.name} (${block.uri})${block.mimeType ? `, ${block.mimeType}` : ""}]`;
  }
  if ("text" in block.resource) return block.resource.text;
  return `[embedded resource: ${block.resource.uri}, ${block.resource.mimeType ?? "unknown type"}, ${Buffer.byteLength(block.resource.blob, "base64")} bytes]`;
}

export function formatCustomMcpResult(result: CallToolResult): string {
  const sections = result.content.map(describeBlock).filter(Boolean);
  if (result.structuredContent) {
    sections.push(`Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`);
  }
  return sections.join("\n\n") || (result.isError ? "The MCP tool failed without an error message." : "Tool completed without output.");
}

async function catalog(manager: CustomMcpManager): Promise<Tool[]> {
  return manager.tools();
}

export async function createCustomMcpClaudeServer(
  manager: CustomMcpManager = customMcpManager,
): Promise<McpSdkServerConfigWithInstance> {
  const tools = await catalog(manager);
  return createSdkMcpServer({
    name: "custom-mcp",
    version: "0.2.0",
    tools: tools.map((definition) =>
      tool(
        definition.name,
        definition.description ?? `Tool provided by the connected custom MCP server.`,
        schemaShape(definition.inputSchema as Record<string, unknown>),
        async (args) => manager.callTool(definition.name, args as Record<string, unknown>),
        { annotations: definition.annotations },
      ),
    ),
  });
}

export async function createCustomMcpRuntimeTools(
  manager: CustomMcpManager = customMcpManager,
): Promise<RuntimeTool[]> {
  const tools = await catalog(manager);
  return tools.map((definition) => {
    const jsonSchema = definition.inputSchema as Record<string, unknown>;
    return {
      namespace: NAMESPACE,
      name: definition.name,
      description: definition.description ?? "Tool provided by the connected custom MCP server.",
      inputSchema: schemaShape(jsonSchema),
      jsonSchema,
      handle: async (args: Record<string, unknown>) => {
        const result = await manager.callTool(definition.name, args);
        return { text: formatCustomMcpResult(result), success: !result.isError };
      },
    };
  });
}
