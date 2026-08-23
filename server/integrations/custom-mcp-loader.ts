import { createCustomMcpClaudeServer, createCustomMcpRuntimeTools } from "../custom-mcp/adapters.js";
import { isCustomMcpConfigured, loadCustomMcpConfig } from "../custom-mcp/config.js";
import { registerIntegration } from "./registry.js";

export function registerCustomMcpIntegration(): void {
  registerIntegration({
    name: "custom-mcp",
    description: "All tools exposed by the locally configured custom MCP server.",
    isEnabled: async () => {
      try {
        return isCustomMcpConfigured(loadCustomMcpConfig());
      } catch {
        return false;
      }
    },
    createServer: async () => createCustomMcpClaudeServer(),
    createTools: async () => createCustomMcpRuntimeTools(),
  });
  console.log("[custom-mcp] registered custom MCP integration");
}
