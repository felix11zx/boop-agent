# Custom MCP integration — Design

**Date:** 2026-08-21
**Status:** Awaiting written-spec review
**Topic:** Connect one unrestricted, user-configured MCP server to Boop and expose its status at the bottom of Connections.

---

## 1. Goals

- Let Boop connect to one custom MCP server running locally or at an explicitly configured HTTP endpoint.
- Support MCP over stdio and Streamable HTTP, with stdio as the recommended same-Mac transport.
- Expose every tool reported by the custom MCP without allowlists, approval gates, or per-tool filtering.
- Make the tools available to both supported execution runtimes: Claude and Codex.
- Add a `Custom MCP` section at the bottom of the Connections page using the same cards, spacing, colors, status treatments, and controls as the existing integrations.
- Keep commands, arguments, environment values, URLs, headers, and credentials local to the Mac running Boop.

## 2. Non-goals

- A browser-based editor for MCP connection details.
- Multiple independently configured custom MCP servers in the first version.
- Tool filtering, read-only mode, confirmation prompts, or policy enforcement.
- Publishing the MCP through Tailscale Funnel or any other public ingress.
- Persisting MCP secrets or transport configuration in Convex.

## 3. User experience

The Connections page gains a final subsection after the account catalog content:

```text
Custom MCP
┌──────────────────────────────────────────────────────────┐
│ Mac MCP                                      Connected   │
│ stdio · 37 tools                                         │
│                                                          │
│                                      Refresh  Disconnect │
└──────────────────────────────────────────────────────────┘
```

The card has five states:

| State | Presentation | Available action |
|---|---|---|
| Not configured | Neutral dot and local configuration guidance | Refresh |
| Disconnected | Neutral dot; configured transport shown | Connect, Refresh |
| Connecting | Busy treatment | No duplicate connect action |
| Connected | Green dot; transport and discovered tool count | Disconnect, Refresh |
| Connection failed | Red/amber status and sanitized error | Connect, Refresh |

The browser receives only the display name, transport, connection state, tool count, and a sanitized error. It never receives the configured command, arguments, environment, URL, headers, or credentials.

`Connect` performs a real MCP initialization and tool-list handshake. `Disconnect` closes the transport and, for stdio, terminates only the child process started by Boop. `Refresh` rechecks the live connection and refreshes the tool catalog; it does not reveal configuration.

## 4. Local configuration

Configuration is read from `.env.local`, following the project's existing local runtime configuration pattern.

Common values:

```env
BOOP_CUSTOM_MCP_ENABLED=true
BOOP_CUSTOM_MCP_NAME="Mac MCP"
BOOP_CUSTOM_MCP_TRANSPORT=stdio
```

Stdio transport:

```env
BOOP_CUSTOM_MCP_COMMAND="/absolute/path/to/mcp-server"
BOOP_CUSTOM_MCP_ARGS_JSON='["arg1", "arg2"]'
BOOP_CUSTOM_MCP_ENV_JSON='{"OPTIONAL_SERVER_VARIABLE":"value"}'
```

Streamable HTTP transport:

```env
BOOP_CUSTOM_MCP_TRANSPORT=http
BOOP_CUSTOM_MCP_URL="http://127.0.0.1:8765/mcp"
BOOP_CUSTOM_MCP_HEADERS_JSON='{"Authorization":"Bearer optional-token"}'
```

Defaults and validation:

- `BOOP_CUSTOM_MCP_ENABLED` defaults to `false`.
- `BOOP_CUSTOM_MCP_NAME` defaults to `Custom MCP`.
- `BOOP_CUSTOM_MCP_TRANSPORT` must be `stdio` or `http` when enabled.
- Stdio requires a non-empty command. Arguments default to an empty array and child environment additions default to an empty object.
- HTTP requires an absolute `http:` or `https:` URL. Headers default to an empty object.
- JSON configuration must have the expected top-level type. Invalid JSON produces a sanitized `Not configured`/configuration-error status without crashing Boop.
- Stdio inherits the MCP SDK's safe default environment and overlays only the explicitly configured entries.
- Configuration changes take effect after restarting Boop. Runtime UI actions do not modify `.env.local`.

## 5. Architecture

### 5.1 Connection manager

Add a single process-wide custom MCP manager under `server/custom-mcp/`. It owns:

- parsed and validated local configuration;
- the MCP SDK client;
- the stdio or Streamable HTTP transport;
- the stdio child lifecycle when applicable;
- the discovered tool catalog;
- connection state, last successful handshake time, and sanitized last error;
- serialized connect/disconnect/refresh operations so repeated UI actions cannot create duplicate clients or child processes.

The manager exposes narrow functions such as:

```ts
getCustomMcpStatus()
connectCustomMcp()
disconnectCustomMcp()
refreshCustomMcp()
listCustomMcpTools()
callCustomMcpTool(name, args)
shutdownCustomMcp()
```

When enabled and validly configured, Boop attempts one automatic connection during server startup. Failure is non-fatal: all non-Custom-MCP features continue to start normally, while the card reports the sanitized error.

The manager is shut down from the server's existing termination path. Unexpected stdio exit changes state to `connection_failed`; the next Connect or Refresh creates a fresh client and process.

### 5.2 Integration registry

Add `server/integrations/custom-mcp-loader.ts` and register it from `loadIntegrations()` regardless of whether it is configured. This keeps status/UI discovery independent from runtime availability.

The integration name is `custom-mcp`. Its description uses the configured display name plus a concise summary derived from discovered tool names/descriptions, so the dispatcher can select it for relevant delegated work.

The integration is enabled for agent execution only while the custom MCP is configured, enabled, and connected. A connection failure therefore prevents agents from receiving dead tools without disabling the rest of Boop.

### 5.3 Claude runtime adapter

The registry currently expects an in-process SDK MCP server for Claude. Add a proxy MCP server that registers each discovered external tool under the `custom-mcp` namespace. Each proxy handler forwards the original arguments to the shared manager and returns the external MCP content/result without applying a tool allowlist.

The proxy is rebuilt from the current discovered catalog when an execution agent is spawned. It reuses the manager's existing external connection rather than starting another MCP process.

### 5.4 Codex runtime adapter

Create dynamic `RuntimeTool` wrappers from the same discovered catalog. Each wrapper:

- preserves the external tool name and description under a collision-safe `custom_mcp` namespace;
- converts the tool's MCP JSON Schema to a Zod object with Zod 4's `fromJSONSchema`, while retaining the original JSON Schema for Codex tool registration;
- forwards all validated arguments to `callCustomMcpTool`;
- preserves text and structured content in the textual runtime result; non-text MCP blocks are represented with their type, MIME type, URI, and available metadata because Boop's current `RuntimeToolResult` supports text only;
- reports external MCP tool errors as unsuccessful runtime tool results.

Both runtime adapters use the same catalog and call path. Claude can receive the external MCP's native content blocks through the proxy; Codex receives a loss-aware textual representation until Boop's runtime tool-result abstraction supports media blocks.

### 5.5 Name collisions

External tools are not filtered or renamed within the external catalog. Boop namespaces the integration as `custom-mcp`/`custom_mcp` at the runtime boundary, preventing collisions with browser, Composio, and built-in tools. Duplicate names returned by the same external server are treated as a connection/catalog error because they cannot be addressed deterministically.

## 6. Local control API

Add an Express router mounted at `/custom-mcp`:

```text
GET  /custom-mcp/status
POST /custom-mcp/connect
POST /custom-mcp/disconnect
POST /custom-mcp/refresh
```

All routes use the same trusted-local-request boundary as the browser controls. Public tunnel traffic receives `403` and cannot start, stop, inspect, or invoke the MCP.

Status response shape:

```json
{
  "configured": true,
  "enabled": true,
  "name": "Mac MCP",
  "transport": "stdio",
  "state": "connected",
  "toolCount": 37,
  "connectedAt": "2026-08-21T18:30:00.000Z",
  "error": null
}
```

Control routes return the updated status after the requested operation. They never return secrets or raw child-process output.

## 7. Error handling and secret hygiene

- Transport, initialization, catalog, tool-call, timeout, and child-exit failures are normalized into short user-facing messages.
- Sanitization removes configured command arguments, environment values, complete URLs with query strings, authorization/header values, and token-like substrings before errors reach the browser, Convex agent logs, or user-facing replies.
- Detailed diagnostics may be written to local server stderr only after applying the same secret redaction.
- Connect and refresh use bounded timeouts. Disconnect remains idempotent.
- A failed tool call does not tear down an otherwise healthy connection unless the transport reports it closed.
- The adapter does not add restrictions to external tools; the custom MCP server remains responsible for its own permissions and side effects.

## 8. Files and components

Expected additions:

- `server/custom-mcp/config.ts` — local configuration parsing and validation
- `server/custom-mcp/manager.ts` — client, transport, lifecycle, catalog, calls
- `server/custom-mcp/adapters.ts` — Claude proxy and Codex runtime wrappers
- `server/custom-mcp/routes.ts` — localhost-only status/control API
- `server/integrations/custom-mcp-loader.ts` — registry integration
- `debug/src/components/CustomMcpSection.tsx` — Connections subsection/card
- focused tests under `test/`

Expected focused changes:

- `server/integrations/registry.ts` — register the loader
- `server/index.ts` — mount routes and start/shutdown lifecycle
- `debug/src/components/ComposioSection.tsx` — render `CustomMcpSection` last
- `.env.example` and `README.md` — document both transports

No Convex schema or function change is required.

## 9. Testing strategy

Automated tests use local fixture MCP servers and never require the user's eventual Mac MCP.

1. Configuration tests
   - disabled/default state
   - valid stdio and HTTP configuration
   - invalid transport, JSON, command, URL, arrays, objects
   - status and error output contains no configured secrets
2. Stdio integration tests
   - initialize, list tools, call tool, refresh, disconnect
   - child exits unexpectedly and can reconnect
   - repeated Connect does not spawn duplicate children
3. Streamable HTTP integration tests
   - initialize, list tools, call tool, refresh, disconnect
   - optional headers are sent but never returned in status/errors
   - unreachable server and timeout behavior
4. Runtime adapter tests
   - all discovered tools are exposed to Claude and Codex
   - arguments and text/error results are forwarded faithfully
   - namespacing prevents collisions
5. Route tests
   - localhost succeeds
   - non-local requests receive `403`
   - response payload is secret-free
6. UI tests
   - all five states render correctly
   - Connect, Disconnect, and Refresh use the intended routes
   - card appears after all existing Connections content
7. Repository verification
   - `npm run typecheck`
   - full `npm test`

After implementation, the user adds the real MCP configuration and restarts Boop. A final manual verification will connect to that server, compare the displayed tool count to `tools/list`, and execute representative Calendar, Reminders, Notes, Stickies, Mail, and Find My tools.

## 10. Security posture explicitly accepted for this feature

The user explicitly requested unrestricted exposure of the custom MCP's tools. Boop therefore adds no allowlist, read-only conversion, or confirmation layer. The safety boundary is:

- local configuration owned by the user;
- localhost-only control API;
- stdio or an explicitly supplied HTTP endpoint;
- transport/server authentication supplied by the user when needed;
- namespace isolation from existing tools.

The design does not expose the MCP through Tailscale Funnel and does not add public ingress. If the configured HTTP URL is remote, Boop connects only to that user-supplied URL and does not publish a reverse endpoint.

## 11. Future extensions

- Multiple named custom MCP servers.
- Editing local MCP configuration from the desktop app through an OS-backed secrets store.
- Per-tool policies or confirmation requirements.
- MCP resources, prompts, and subscriptions beyond tool discovery/calls.
- Private Tailscale Serve integration for a Boop server running on another tailnet device.
