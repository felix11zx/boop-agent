import { describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CustomMcpConfig } from "../server/custom-mcp/config.js";
import {
  createCustomMcpTransport,
  CustomMcpManager,
} from "../server/custom-mcp/manager.js";

const stdioConfig: CustomMcpConfig = {
  enabled: true,
  name: "Mac MCP",
  transport: "stdio",
  command: "/opt/mac-mcp",
  args: [],
  env: {},
};

function fakeClient(tools = [{ name: "calendar_list", inputSchema: { type: "object" as const } }]) {
  const client = {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools })),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    close: vi.fn(async () => undefined),
  };
  return client as typeof client & Client;
}

describe("custom MCP manager", () => {
  it("constructs both supported SDK transports", () => {
    expect(createCustomMcpTransport(stdioConfig)).toBeInstanceOf(StdioClientTransport);
    expect(
      createCustomMcpTransport({
        enabled: true,
        name: "Remote MCP",
        transport: "http",
        url: "http://127.0.0.1:8765/mcp",
        headers: {},
      }),
    ).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it("connects once, catalogs tools, and forwards unrestricted calls", async () => {
    const client = fakeClient();
    const manager = new CustomMcpManager(
      () => stdioConfig,
      () => ({}) as Transport,
      () => client,
    );

    await Promise.all([manager.connect(), manager.connect()]);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(manager.status()).toMatchObject({ state: "connected", toolCount: 1 });
    await expect(manager.callTool("calendar_list", { range: "today" })).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
    expect(client.callTool).toHaveBeenCalledWith({
      name: "calendar_list",
      arguments: { range: "today" },
    });
  });

  it("redacts configured secrets from connection errors", async () => {
    const config: CustomMcpConfig = {
      enabled: true,
      name: "Remote MCP",
      transport: "http",
      url: "http://127.0.0.1:8765/mcp",
      headers: { Authorization: "super-secret-token" },
    };
    const client = fakeClient([
      { name: "mail_send", inputSchema: { type: "object" as const } },
      { name: "mail_send", inputSchema: { type: "object" as const } },
    ]);
    client.listTools.mockRejectedValueOnce(new Error("Authorization: super-secret-token"));
    const manager = new CustomMcpManager(
      () => config,
      () => ({}) as Transport,
      () => client,
    );

    await expect(manager.connect()).rejects.not.toThrow("super-secret-token");
    expect(manager.status().error).not.toContain("super-secret-token");
    expect(client.close).toHaveBeenCalled();
  });

  it("rejects duplicate tool names", async () => {
    const client = fakeClient([
      { name: "mail_send", inputSchema: { type: "object" as const } },
      { name: "mail_send", inputSchema: { type: "object" as const } },
    ]);
    const manager = new CustomMcpManager(
      () => stdioConfig,
      () => ({}) as Transport,
      () => client,
    );

    await expect(manager.connect()).rejects.toThrow("duplicate tool name");
    expect(manager.status()).toMatchObject({ state: "error", toolCount: 0 });
  });
});
