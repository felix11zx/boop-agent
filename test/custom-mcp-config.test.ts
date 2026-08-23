import { describe, expect, it } from "vitest";
import {
  isCustomMcpConfigured,
  loadCustomMcpConfig,
  validateCustomMcpConfig,
} from "../server/custom-mcp/config.js";

describe("custom MCP configuration", () => {
  it("parses a stdio server without inventing credentials", () => {
    const config = loadCustomMcpConfig({
      BOOP_CUSTOM_MCP_ENABLED: "true",
      BOOP_CUSTOM_MCP_NAME: "Mac MCP",
      BOOP_CUSTOM_MCP_TRANSPORT: "stdio",
      BOOP_CUSTOM_MCP_COMMAND: "/opt/mac-mcp",
      BOOP_CUSTOM_MCP_ARGS_JSON: '["serve","--stdio"]',
      BOOP_CUSTOM_MCP_ENV_JSON: '{"LOG_LEVEL":"warn"}',
    });

    expect(config).toEqual({
      enabled: true,
      name: "Mac MCP",
      transport: "stdio",
      command: "/opt/mac-mcp",
      args: ["serve", "--stdio"],
      env: { LOG_LEVEL: "warn" },
    });
    expect(isCustomMcpConfigured(config)).toBe(true);
    expect(() => validateCustomMcpConfig(config)).not.toThrow();
  });

  it("parses Streamable HTTP headers", () => {
    expect(
      loadCustomMcpConfig({
        BOOP_CUSTOM_MCP_ENABLED: "1",
        BOOP_CUSTOM_MCP_TRANSPORT: "http",
        BOOP_CUSTOM_MCP_URL: "http://127.0.0.1:8765/mcp",
        BOOP_CUSTOM_MCP_HEADERS_JSON: '{"Authorization":"Bearer local-secret"}',
      }),
    ).toMatchObject({
      enabled: true,
      transport: "http",
      url: "http://127.0.0.1:8765/mcp",
      headers: { Authorization: "Bearer local-secret" },
    });
  });

  it("rejects malformed JSON and incomplete enabled configurations", () => {
    expect(() =>
      loadCustomMcpConfig({
        BOOP_CUSTOM_MCP_ENABLED: "true",
        BOOP_CUSTOM_MCP_ARGS_JSON: "not-json",
      }),
    ).toThrow("BOOP_CUSTOM_MCP_ARGS_JSON must be valid JSON");

    const config = loadCustomMcpConfig({ BOOP_CUSTOM_MCP_ENABLED: "true" });
    expect(isCustomMcpConfigured(config)).toBe(false);
    expect(() => validateCustomMcpConfig(config)).toThrow("BOOP_CUSTOM_MCP_COMMAND");
  });
});
