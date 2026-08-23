export type CustomMcpTransport = "stdio" | "http";

export interface CustomMcpConfigBase {
  enabled: boolean;
  name: string;
  transport: CustomMcpTransport;
}

export interface CustomMcpStdioConfig extends CustomMcpConfigBase {
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CustomMcpHttpConfig extends CustomMcpConfigBase {
  transport: "http";
  url: string;
  headers: Record<string, string>;
}

export type CustomMcpConfig = CustomMcpStdioConfig | CustomMcpHttpConfig;

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function parseStringArray(value: string | undefined, key: string): string[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${key} must be valid JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`${key} must be a JSON array of strings.`);
  }
  return parsed;
}

function parseStringRecord(value: string | undefined, key: string): Record<string, string> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${key} must be valid JSON.`);
  }
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    Object.values(parsed).some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${key} must be a JSON object whose values are strings.`);
  }
  return parsed as Record<string, string>;
}

export function loadCustomMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): CustomMcpConfig {
  const enabled = parseBoolean(env.BOOP_CUSTOM_MCP_ENABLED);
  const name = env.BOOP_CUSTOM_MCP_NAME?.trim() || "Custom MCP";
  const rawTransport = env.BOOP_CUSTOM_MCP_TRANSPORT?.trim().toLowerCase() || "stdio";
  if (rawTransport !== "stdio" && rawTransport !== "http") {
    throw new Error('BOOP_CUSTOM_MCP_TRANSPORT must be either "stdio" or "http".');
  }

  if (rawTransport === "stdio") {
    return {
      enabled,
      name,
      transport: "stdio",
      command: env.BOOP_CUSTOM_MCP_COMMAND?.trim() ?? "",
      args: parseStringArray(env.BOOP_CUSTOM_MCP_ARGS_JSON, "BOOP_CUSTOM_MCP_ARGS_JSON"),
      env: parseStringRecord(env.BOOP_CUSTOM_MCP_ENV_JSON, "BOOP_CUSTOM_MCP_ENV_JSON"),
    };
  }

  const url = env.BOOP_CUSTOM_MCP_URL?.trim() ?? "";
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("BOOP_CUSTOM_MCP_URL must be a valid URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("BOOP_CUSTOM_MCP_URL must use http or https.");
    }
  }
  return {
    enabled,
    name,
    transport: "http",
    url,
    headers: parseStringRecord(
      env.BOOP_CUSTOM_MCP_HEADERS_JSON,
      "BOOP_CUSTOM_MCP_HEADERS_JSON",
    ),
  };
}

export function validateCustomMcpConfig(config: CustomMcpConfig): void {
  if (!config.enabled) throw new Error("Custom MCP is disabled.");
  if (config.transport === "stdio" && !config.command) {
    throw new Error("BOOP_CUSTOM_MCP_COMMAND is required for the stdio transport.");
  }
  if (config.transport === "http" && !config.url) {
    throw new Error("BOOP_CUSTOM_MCP_URL is required for the HTTP transport.");
  }
}

export function isCustomMcpConfigured(config: CustomMcpConfig): boolean {
  return config.enabled &&
    (config.transport === "stdio" ? Boolean(config.command) : Boolean(config.url));
}
