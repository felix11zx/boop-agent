import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  isCustomMcpConfigured,
  loadCustomMcpConfig,
  validateCustomMcpConfig,
  type CustomMcpConfig,
} from "./config.js";

export type CustomMcpConnectionState =
  | "not_configured"
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface CustomMcpStatus {
  configured: boolean;
  enabled: boolean;
  name: string;
  transport: "stdio" | "http";
  state: CustomMcpConnectionState;
  toolCount: number;
  error: string | null;
}

type TransportFactory = (config: CustomMcpConfig) => Transport;
type ClientFactory = () => Client;

export function createCustomMcpTransport(config: CustomMcpConfig): Transport {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...config.env },
      stderr: "inherit",
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
  });
}

function safeError(error: unknown, config?: CustomMcpConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = config
    ? config.transport === "http"
      ? [config.url, ...Object.values(config.headers)]
      : [config.command, ...config.args, ...Object.values(config.env)]
    : [];
  for (const secret of secrets) {
    if (secret.length >= 4) message = message.split(secret).join("[redacted]");
  }
  return message.replace(/(authorization|token|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

export class CustomMcpManager {
  private client: Client | null = null;
  private catalog: Tool[] = [];
  private state: CustomMcpConnectionState = "disconnected";
  private error: string | null = null;
  private connectPromise: Promise<CustomMcpStatus> | null = null;

  constructor(
    private readonly configLoader: () => CustomMcpConfig = loadCustomMcpConfig,
    private readonly transportFactory: TransportFactory = createCustomMcpTransport,
    private readonly clientFactory: ClientFactory = () =>
      new Client({ name: "boop-custom-mcp-client", version: "0.2.0" }),
  ) {}

  status(): CustomMcpStatus {
    try {
      const config = this.configLoader();
      const configured = isCustomMcpConfigured(config);
      return {
        configured,
        enabled: config.enabled,
        name: config.name,
        transport: config.transport,
        state: configured ? this.state : "not_configured",
        toolCount: this.catalog.length,
        error: this.error,
      };
    } catch (error) {
      return {
        configured: false,
        enabled: false,
        name: "Custom MCP",
        transport: "stdio",
        state: "error",
        toolCount: 0,
        error: safeError(error),
      };
    }
  }

  async connect(): Promise<CustomMcpStatus> {
    if (this.state === "connected" && this.client) return this.status();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.performConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async performConnect(): Promise<CustomMcpStatus> {
    const config = this.configLoader();
    let candidateClient: Client | null = null;
    try {
      validateCustomMcpConfig(config);
      this.state = "connecting";
      this.error = null;
      const client = this.clientFactory();
      candidateClient = client;
      await client.connect(this.transportFactory(config));
      const { tools } = await client.listTools();
      const names = new Set<string>();
      for (const entry of tools) {
        if (names.has(entry.name)) {
          throw new Error(`The MCP server returned the duplicate tool name "${entry.name}".`);
        }
        names.add(entry.name);
      }
      this.client = client;
      this.catalog = tools as Tool[];
      this.state = "connected";
      return this.status();
    } catch (error) {
      await candidateClient?.close().catch(() => undefined);
      this.client = null;
      this.catalog = [];
      this.state = isCustomMcpConfigured(config) ? "error" : "not_configured";
      this.error = safeError(error, config);
      throw new Error(this.error);
    }
  }

  async disconnect(): Promise<CustomMcpStatus> {
    const client = this.client;
    this.client = null;
    this.catalog = [];
    this.error = null;
    this.state = isCustomMcpConfigured(this.configLoader()) ? "disconnected" : "not_configured";
    if (client) await client.close();
    return this.status();
  }

  async refresh(): Promise<CustomMcpStatus> {
    if (!this.client || this.state !== "connected") return this.connect();
    try {
      const { tools } = await this.client.listTools();
      const names = new Set<string>();
      for (const entry of tools) {
        if (names.has(entry.name)) throw new Error(`Duplicate tool name "${entry.name}".`);
        names.add(entry.name);
      }
      this.catalog = tools as Tool[];
      this.error = null;
      return this.status();
    } catch (error) {
      const client = this.client;
      this.client = null;
      await client.close().catch(() => undefined);
      this.state = "error";
      this.error = safeError(error, this.configLoader());
      throw new Error(this.error);
    }
  }

  async tools(): Promise<Tool[]> {
    if (!this.client || this.state !== "connected") await this.connect();
    return [...this.catalog];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.client || this.state !== "connected") await this.connect();
    const result = await this.client!.callTool({ name, arguments: args });
    if ("toolResult" in result) {
      return { content: [{ type: "text", text: JSON.stringify(result.toolResult) }] };
    }
    return result as CallToolResult;
  }
}

export const customMcpManager = new CustomMcpManager();
