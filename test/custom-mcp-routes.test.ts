import { describe, expect, it, vi } from "vitest";
import type { CustomMcpManager } from "../server/custom-mcp/manager.js";
import { createCustomMcpRouter } from "../server/custom-mcp/routes.js";

interface RouterLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> | void }>;
  };
  handle: (req: unknown, res: unknown, next: () => void) => void;
}

function layers(manager: CustomMcpManager): RouterLayer[] {
  return (createCustomMcpRouter(manager) as unknown as { stack: RouterLayer[] }).stack;
}

describe("custom MCP local control routes", () => {
  it("registers status and lifecycle controls and invokes connect", async () => {
    const status = {
      configured: true,
      enabled: true,
      name: "Mac MCP",
      transport: "stdio" as const,
      state: "disconnected" as const,
      toolCount: 0,
      error: null,
    };
    const manager = {
      status: vi.fn(() => status),
      connect: vi.fn(async () => ({ ...status, state: "connected" as const, toolCount: 12 })),
      disconnect: vi.fn(),
      refresh: vi.fn(),
    } as unknown as CustomMcpManager;
    const stack = layers(manager);
    expect(stack.flatMap((layer) => layer.route?.path ?? [])).toEqual([
      "/status",
      "/connect",
      "/disconnect",
      "/refresh",
    ]);

    const connectLayer = stack.find((layer) => layer.route?.path === "/connect");
    const response = { json: vi.fn(), status: vi.fn() };
    response.status.mockReturnValue(response);
    await connectLayer?.route?.stack[0]?.handle({}, response);
    expect(manager.connect).toHaveBeenCalledOnce();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      state: "connected",
      toolCount: 12,
    }));
  });

  it("rejects control requests carrying a non-local forwarding address", () => {
    const manager = {
      status: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      refresh: vi.fn(),
    } as unknown as CustomMcpManager;
    const middleware = layers(manager)[0];
    const response = { json: vi.fn(), status: vi.fn() };
    response.status.mockReturnValue(response);
    const next = vi.fn();

    middleware.handle(
      {
        method: "GET",
        url: "/status",
        headers: { host: "localhost:3456", "x-forwarded-for": "203.0.113.20" },
        socket: { remoteAddress: "127.0.0.1" },
      },
      response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
  });
});
