import { useCallback, useEffect, useState } from "react";

type CustomMcpState =
  | "not_configured"
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

interface CustomMcpStatus {
  configured: boolean;
  enabled: boolean;
  name: string;
  transport: "stdio" | "http";
  state: CustomMcpState;
  toolCount: number;
  error: string | null;
}

const LABELS: Record<CustomMcpState, string> = {
  not_configured: "Not configured",
  disconnected: "Disconnected",
  connecting: "Connecting",
  connected: "Connected",
  error: "Connection failed",
};

export function CustomMcpSection({ isDark }: { isDark: boolean }) {
  const [status, setStatus] = useState<CustomMcpStatus | null>(null);
  const [busy, setBusy] = useState<"connect" | "disconnect" | "refresh" | null>(null);
  const muted = isDark ? "text-zinc-500" : "text-zinc-400";
  const cardBg = isDark
    ? "border-white/10 bg-[#202024] shadow-black/20"
    : "border-zinc-200 bg-white shadow-zinc-200/50";

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/custom-mcp/status", { cache: "no-store" });
      if (!response.ok) throw new Error(response.statusText);
      setStatus((await response.json()) as CustomMcpStatus);
    } catch (error) {
      setStatus({
        configured: false,
        enabled: false,
        name: "Custom MCP",
        transport: "stdio",
        state: "error",
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const action = useCallback(
    async (operation: "connect" | "disconnect" | "refresh") => {
      setBusy(operation);
      if (operation === "connect") {
        setStatus((current) =>
          current ? { ...current, state: "connecting", error: null } : current,
        );
      }
      try {
        const response = await fetch(`/api/custom-mcp/${operation}`, { method: "POST" });
        const body = (await response.json()) as CustomMcpStatus;
        setStatus(body);
      } catch (error) {
        setStatus((current) =>
          current
            ? {
                ...current,
                state: "error",
                error: error instanceof Error ? error.message : String(error),
              }
            : current,
        );
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const state = status?.state ?? "connecting";
  const connected = state === "connected";
  const dotClass = connected
    ? "bg-emerald-400"
    : state === "connecting"
      ? "bg-amber-400"
      : state === "error"
        ? "bg-rose-400"
        : "bg-zinc-500";
  const stateText = connected
    ? "text-emerald-500"
    : state === "connecting"
      ? "text-amber-500"
      : state === "error"
        ? "text-rose-500"
        : muted;

  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-3 px-0.5">
        <div>
          <h3 className={`text-xs font-medium ${isDark ? "text-zinc-300" : "text-zinc-700"}`}>
            Custom MCP
          </h3>
          <p className={`mt-0.5 text-[11px] ${muted}`}>
            Your own MCP server, configured locally
          </p>
        </div>
      </div>
      <div className={`rounded-2xl border px-4 py-3.5 shadow-sm fade-in ${cardBg}`}>
        <div className="flex items-center gap-4">
          <div
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[10px] font-semibold mono ${
              isDark ? "bg-white/10 text-zinc-200" : "bg-zinc-100 text-zinc-700"
            }`}
          >
            MCP
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`text-sm font-medium ${isDark ? "text-zinc-100" : "text-zinc-900"}`}
              >
                {status?.name ?? "Custom MCP"}
              </span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                  isDark ? "bg-white/5 text-zinc-400" : "bg-zinc-100 text-zinc-500"
                }`}
              >
                {status?.transport ?? "stdio"}
              </span>
            </div>
            <p className={`mt-0.5 text-xs leading-snug ${muted}`}>
              Exposes every tool provided by this server to Claude and Codex.
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 text-xs ${stateText}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
                {LABELS[state]}
              </span>
              {connected && (
                <span className={`text-[10px] mono ${muted}`}>
                  {status?.toolCount ?? 0} tools
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {connected && (
              <button
                onClick={() => void action("refresh")}
                disabled={busy !== null}
                className={`rounded-xl border px-2.5 py-1.5 text-xs transition-colors ${
                  isDark
                    ? "border-white/10 text-zinc-300 hover:bg-white/5"
                    : "border-zinc-200 text-zinc-600 hover:bg-zinc-100"
                } disabled:opacity-50`}
              >
                {busy === "refresh" ? "Refreshing..." : "Refresh"}
              </button>
            )}
            <button
              onClick={() => void action(connected ? "disconnect" : "connect")}
              disabled={busy !== null || (!status?.configured && state !== "error")}
              className={`rounded-xl px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                connected
                  ? isDark
                    ? "border border-white/10 text-zinc-300 hover:bg-white/5"
                    : "border border-zinc-200 text-zinc-600 hover:bg-zinc-100"
                  : isDark
                    ? "bg-zinc-100 text-zinc-950 hover:bg-white"
                    : "bg-zinc-950 text-white hover:bg-zinc-800"
              }`}
            >
              {busy === "connect"
                ? "Connecting..."
                : busy === "disconnect"
                  ? "Disconnecting..."
                  : connected
                    ? "Disconnect"
                    : state === "error"
                      ? "Retry"
                      : "Connect"}
            </button>
          </div>
        </div>
        {!status?.configured && state !== "error" && (
          <p
            className={`mt-3 border-t pt-3 text-xs ${isDark ? "border-white/10 text-zinc-400" : "border-zinc-100 text-zinc-500"}`}
          >
            Add the <code>BOOP_CUSTOM_MCP_*</code> values to <code>.env.local</code>, then
            restart Boop.
          </p>
        )}
        {status?.error && (
          <p
            className={`mt-3 break-words rounded-xl border px-3 py-2 text-xs ${
              isDark
                ? "border-rose-500/20 bg-rose-500/5 text-rose-300"
                : "border-rose-200 bg-rose-50 text-rose-700"
            }`}
          >
            {status.error}
          </p>
        )}
      </div>
    </div>
  );
}
