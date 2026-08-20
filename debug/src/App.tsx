import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  MachineRobotIcon,
  AiBrain02Icon,
  WorkflowCircle03Icon,
  Activity01Icon,
  Link04Icon,
  DashboardSquare01Icon,
  ArrowShrink02Icon,
  Settings01Icon,
  Moon02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { api } from "../../convex/_generated/api.js";
import { useSocket } from "./lib/useSocket.js";
import { DashboardPanel } from "./components/DashboardPanel.js";
import { AgentsPanel } from "./components/AgentsPanel.js";
import { AutomationsPanel } from "./components/AutomationsPanel.js";
import { MemoryPanel } from "./components/MemoryPanel.js";
import { EventsPanel } from "./components/EventsPanel.js";
import { ConnectionsPanel } from "./components/ConnectionsPanel.js";
import { ConsolidationPanel } from "./components/ConsolidationPanel.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { ChangelogDrawer } from "./components/ChangelogDrawer.js";
import { RuntimeProviderLogo, type RuntimeProvider } from "./lib/branding.js";
import boopGif from "../../assets/boop.gif";

type View =
  | "dashboard"
  | "agents"
  | "automations"
  | "memory"
  | "events"
  | "consolidation"
  | "connections"
  | "settings";

type Theme = "dark" | "light";

interface RuntimeConfigSnapshot {
  runtime: RuntimeProvider;
  model: string;
}

interface MemoryTierCounts {
  short: number;
  long: number;
  permanent: number;
}

interface AgentSummary {
  status: string;
}

interface DesktopStatus {
  state: string;
  server: string;
  convex: string;
  dashboard: string;
  tunnel: string;
  webhook?: string;
  dashboardUrl?: string;
  publicUrl?: string;
  expectedWebhookUrl?: string;
  registeredWebhookUrl?: string;
  webhookDetails?: string;
  webhookCheckedAt?: string;
  convexUrl?: string;
  phoneNumber?: string;
  runtimeRoot?: string;
  lastMessage?: string;
}

type DesktopAction =
  | "start"
  | "stop"
  | "restart"
  | "checkWebhook"
  | "openDashboard"
  | "showRuntimeFolder"
  | "status";

const DEMO_PHONE_NUMBER = "+11111111111";

const NAV_ICONS: Record<View, any> = {
  dashboard: DashboardSquare01Icon,
  agents: MachineRobotIcon,
  automations: WorkflowCircle03Icon,
  memory: AiBrain02Icon,
  events: Activity01Icon,
  consolidation: ArrowShrink02Icon,
  connections: Link04Icon,
  settings: Settings01Icon,
};

const NAV: { id: View; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "agents", label: "Agents" },
  { id: "automations", label: "Automations" },
  { id: "memory", label: "Memory" },
  { id: "events", label: "Events" },
  { id: "consolidation", label: "Consolidation" },
  { id: "connections", label: "Connections" },
  { id: "settings", label: "Settings" },
];

function getStoredTheme(): Theme {
  try {
    return (localStorage.getItem("boop-debug-theme") as Theme) || "dark";
  } catch {
    return "dark";
  }
}

export function App() {
  const [view, setView] = useState<View>("dashboard");
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const [runtimeConfig, setRuntimeConfig] = useState<
    RuntimeConfigSnapshot | null | undefined
  >(undefined);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [desktopStatus, setDesktopStatus] = useState<DesktopStatus | null>(null);
  const { connected } = useSocket();

  const counts = useQuery(api.memoryRecords.countsByTier, {}) as
    | MemoryTierCounts
    | undefined;
  const agents = useQuery(api.agents.listForDashboard, {}) as AgentSummary[] | undefined;
  const demoStatus = useQuery(api.demo.status);
  const storedRuntime = useQuery(api.settings.get, { key: "runtime" }) as
    | string
    | null
    | undefined;
  const storedClaudeModel = useQuery(api.settings.get, { key: "model" }) as
    | string
    | null
    | undefined;
  const storedHostedModel = useQuery(api.settings.get, { key: "codex_model" }) as
    | string
    | null
    | undefined;
  const activeAgentCount = (agents ?? []).filter(
    (a) => a.status === "running" || a.status === "spawned",
  ).length;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.classList.toggle("light", theme === "light");
    document.body.style.background = theme === "dark" ? "#101012" : "#f7f7f5";
    document.body.style.color = theme === "dark" ? "#f4f4f5" : "#18181b";
    localStorage.setItem("boop-debug-theme", theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    let timeout: number | undefined;
    let attempt = 0;

    async function loadRuntimeConfig() {
      try {
        const res = await fetch("/api/runtime-config", { cache: "no-store" });
        if (!res.ok) throw new Error(`Runtime config fetch failed (${res.status})`);
        const config = (await res.json()) as RuntimeConfigSnapshot;
        if (!cancelled) setRuntimeConfig(config);
      } catch {
        if (cancelled) return;
        setRuntimeConfig(null);
        if (attempt < 20) {
          const delay = Math.min(750 + attempt * 250, 4000);
          attempt += 1;
          timeout = window.setTimeout(loadRuntimeConfig, delay);
        }
      }
    }

    loadRuntimeConfig();
    return () => {
      cancelled = true;
      if (timeout) window.clearTimeout(timeout);
    };
  }, [
    connected,
    desktopStatus?.server,
    desktopStatus?.state,
    storedRuntime,
    storedClaudeModel,
    storedHostedModel,
  ]);

  useEffect(() => {
    function onDesktopStatus(event: MessageEvent) {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || data.type !== "boop-desktop-status") return;
      setDesktopStatus(data.status as DesktopStatus);
    }

    window.addEventListener("message", onDesktopStatus);
    window.parent?.postMessage({ type: "boop-desktop-status-request" }, "*");
    return () => window.removeEventListener("message", onDesktopStatus);
  }, []);

  function sendDesktopAction(action: DesktopAction) {
    window.parent?.postMessage({ type: "boop-desktop-action", action }, "*");
  }

  const isDark = theme === "dark";
  const currentView = NAV.find((item) => item.id === view)?.label ?? "Dashboard";
  const demoModeEnabled = demoStatus?.enabled ?? false;
  const storedProvider: RuntimeProvider | null =
    storedRuntime === "claude" || storedRuntime === "codex" ? storedRuntime : null;
  const activeRuntime = runtimeConfig?.runtime ?? storedProvider ?? (demoModeEnabled ? "codex" : null);
  const providerLabel = activeRuntime
    ? activeRuntime === "codex"
      ? "Codex"
      : "Claude"
    : "Runtime";
  const modelLabel =
    runtimeConfig?.model ??
    (activeRuntime
      ? activeRuntime === "codex"
        ? storedHostedModel
        : storedClaudeModel
      : undefined) ??
    (demoModeEnabled ? "gpt-5.6-sol" : undefined) ??
    (runtimeConfig === undefined ? "Checking..." : "Model unavailable");
  const inDesktopShell = desktopStatus !== null;
  const displayDesktopStatus =
    desktopStatus && demoModeEnabled
      ? { ...desktopStatus, phoneNumber: DEMO_PHONE_NUMBER }
      : desktopStatus;
  const displayConnected = demoModeEnabled ? true : connected;

  return (
    <div
      className={`h-full flex ${
        isDark ? "bg-[#101012] text-zinc-100" : "bg-[#f7f7f5] text-zinc-900"
      }`}
    >
      <nav
        className={`desktop-drag-region w-[244px] shrink-0 px-3 pb-3 ${inDesktopShell ? "pt-12" : "pt-3"} flex flex-col ${
          isDark ? "bg-[#101012]" : "bg-[#f7f7f5]"
        }`}
      >
        <ConnectionHeader
          connected={displayConnected}
          desktopStatus={displayDesktopStatus}
          isDark={isDark}
          onAction={sendDesktopAction}
        />

        <div className="mt-5 space-y-0.5">
          {NAV.map((item) => (
            <button
              key={item.id}
              data-active={view === item.id}
              onClick={() => setView(item.id)}
              className={`desktop-no-drag sidebar-nav-item flex h-8 w-full items-center gap-2 rounded-2xl px-2.5 text-left text-[12px] ${
                view === item.id
                  ? isDark
                    ? "text-zinc-50"
                    : "text-zinc-950"
                  : isDark
                    ? "text-zinc-400 hover:text-zinc-100"
                    : "text-zinc-600 hover:text-zinc-950"
              }`}
            >
              <HugeiconsIcon icon={NAV_ICONS[item.id]} size={16} className="shrink-0" />
              <span className="truncate">{item.label}</span>
              {item.id === "agents" && activeAgentCount > 0 && (
                <span
                  className={`ml-auto flex h-4 min-w-4 items-center justify-center rounded-full px-1.5 text-[10px] font-medium ${
                    isDark ? "bg-zinc-700 text-zinc-100" : "bg-zinc-200 text-zinc-800"
                  }`}
                >
                  {activeAgentCount}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="mt-auto space-y-3">
          {counts && (
            <div
              className={`rounded-2xl border p-2.5 ${
                isDark ? "border-white/10 bg-black/20" : "border-zinc-200 bg-zinc-50"
              }`}
            >
              <div className={`mb-2 text-xs ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>
                Memory
              </div>
              <div className="grid grid-cols-3 gap-2">
                <MetricPill label="Short" value={counts.short} isDark={isDark} />
                <MetricPill label="Long" value={counts.long} isDark={isDark} />
                <MetricPill
                  label="Perm"
                  value={counts.permanent}
                  isDark={isDark}
                  color={isDark ? "text-amber-300" : "text-amber-700"}
                />
              </div>
            </div>
          )}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center">
              <button
                onClick={() => setChangelogOpen(true)}
                aria-label="Open changelog"
                className={`desktop-no-drag rounded-lg px-1.5 py-1 text-[11px] mono transition-colors ${
                  isDark
                    ? "text-zinc-600 hover:bg-white/5 hover:text-zinc-300"
                    : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                }`}
                title="Open changelog"
              >
                v0.2
              </button>
            </div>
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className={`desktop-no-drag p-1.5 rounded-xl transition-colors ${
                isDark
                  ? "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
              }`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            >
              <HugeiconsIcon icon={isDark ? Sun03Icon : Moon02Icon} size={16} />
            </button>
          </div>
        </div>
      </nav>

      <div
        className={`relative flex flex-1 min-w-0 flex-col overflow-hidden rounded-l-[20px] border-y border-l shadow-sm ${
          isDark
            ? "border-white/10 bg-[#18181b] shadow-black/20"
            : "border-zinc-200 bg-[#fbfbfa] shadow-zinc-200/60"
        }`}
      >
        <header
          className={`desktop-drag-region flex h-14 shrink-0 items-center justify-between border-b px-5 ${
            isDark ? "border-white/10 bg-[#18181b]" : "border-zinc-200 bg-[#fbfbfa]"
          }`}
        >
          <div>
            <div className={`text-[11px] ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>
              Boop Debug
            </div>
            <h2 className={`text-sm font-medium ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>
              {currentView}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setView("settings")}
            className={`desktop-no-drag hidden min-w-0 items-center gap-2 rounded-2xl border px-2.5 py-1.5 text-xs sm:flex ${
              isDark ? "border-white/10 bg-white/5 text-zinc-400" : "border-zinc-200 bg-white text-zinc-600"
            }`}
            title={`Active model: ${providerLabel} ${modelLabel}`}
            aria-label="Open settings"
          >
            {activeRuntime ? (
              <RuntimeProviderLogo runtime={activeRuntime} size={17} className="shrink-0" />
            ) : (
              <span
                className={`h-[17px] w-[17px] shrink-0 rounded-md border ${
                  isDark ? "border-white/10 bg-white/5" : "border-zinc-200 bg-zinc-100"
                }`}
              />
            )}
            <span className={`shrink-0 font-medium ${isDark ? "text-zinc-300" : "text-zinc-700"}`}>
              {providerLabel}
            </span>
            <span className={`max-w-[180px] truncate mono font-medium ${isDark ? "text-zinc-200" : "text-zinc-800"}`}>
              {modelLabel}
            </span>
          </button>
        </header>

        <main className="flex-1 min-h-0 min-w-0 overflow-hidden">
          <div key={view} className="h-full overflow-auto debug-scroll p-5 view-shell">
            {view === "dashboard" && <DashboardPanel isDark={isDark} />}
            {view === "agents" && <AgentsPanel isDark={isDark} />}
            {view === "automations" && <AutomationsPanel isDark={isDark} />}
            {view === "memory" && (
              <MemoryPanel isDark={isDark} demoMode={demoModeEnabled} />
            )}
            {view === "events" && <EventsPanel isDark={isDark} />}
            {view === "consolidation" && <ConsolidationPanel isDark={isDark} />}
            {view === "connections" && <ConnectionsPanel isDark={isDark} />}
            {view === "settings" && (
              <SettingsPanel
                isDark={isDark}
                desktopPhoneNumber={displayDesktopStatus?.phoneNumber}
              />
            )}
          </div>
        </main>
        <ChangelogDrawer
          open={changelogOpen}
          onClose={() => setChangelogOpen(false)}
          isDark={isDark}
        />
      </div>
    </div>
  );
}

function MetricPill({
  label,
  value,
  isDark,
  color,
}: {
  label: string;
  value: number;
  isDark: boolean;
  color?: string;
}) {
  return (
    <div className="min-w-0 text-xs">
      <span className={isDark ? "text-zinc-500" : "text-zinc-400"}>{label}</span>
      <span
        className={`block truncate mono font-semibold ${
          color ?? (isDark ? "text-zinc-300" : "text-zinc-700")
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function ConnectionHeader({
  connected,
  desktopStatus,
  isDark,
  onAction,
}: {
  connected: boolean;
  desktopStatus: DesktopStatus | null;
  isDark: boolean;
  onAction: (action: DesktopAction) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const open = hovered || expanded;
  const services = desktopStatus
    ? [
        { label: "Boop agent", value: desktopStatus.state },
        { label: "Server", value: desktopStatus.server },
        { label: "Convex", value: desktopStatus.convex },
        { label: "Dashboard", value: desktopStatus.dashboard },
        { label: "Tunnel", value: desktopStatus.tunnel },
        { label: "Sendblue webhook", value: desktopStatus.webhook ?? "unknown" },
      ]
    : [{ label: "Dashboard socket", value: connected ? "running" : "stopped" }];
  const starting = desktopStatus ? isDesktopStarting(desktopStatus) : false;
  const active = desktopStatus ? isDesktopActive(desktopStatus) : connected;
  const connectionActions: { label: string; action: DesktopAction }[] = [];
  if (desktopStatus) {
    if (!active && !starting) connectionActions.push({ label: "Start", action: "start" });
    if (active) connectionActions.push({ label: "Stop", action: "stop" });
    if (active && !starting) connectionActions.push({ label: "Restart", action: "restart" });
    if (desktopStatus.expectedWebhookUrl || desktopStatus.publicUrl) {
      connectionActions.push({ label: "Check", action: "checkWebhook" });
    }
  }
  const webhookState = desktopStatus?.webhook ?? "unknown";
  const webhookProblem = ["mismatch", "missing", "error", "no-tunnel"].includes(webhookState);
  const healthy = desktopStatus
    ? desktopStatus.state === "running" && connected && !webhookProblem && webhookState === "registered"
    : connected;
  const statusText = webhookProblem
    ? webhookState === "mismatch"
      ? "Webhook mismatch"
      : webhookState === "missing"
        ? "Webhook missing"
        : webhookState === "no-tunnel"
          ? "No public tunnel"
          : "Webhook check failed"
    : webhookState === "checking"
      ? "Checking webhook"
    : healthy
      ? "Connection healthy"
      : connected
        ? "Boop starting"
        : "Disconnected";

  return (
    <div
      className="relative z-40"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setExpanded((value) => !value)}
        className={`desktop-no-drag flex w-full items-center gap-3 rounded-2xl px-1.5 py-1 text-left ${
          isDark ? "hover:bg-white/5" : "hover:bg-white/70"
        }`}
      >
        <img src={boopGif} alt="Boop" className="h-8 w-8 rounded-2xl object-cover" />
        <div className="min-w-0">
          <h1 className={`truncate text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>
            Boop
          </h1>
          <div
            className={`flex items-center gap-1.5 truncate text-xs ${
              healthy ? "text-emerald-500" : connected ? "text-amber-400" : "text-rose-400"
            }`}
          >
            <span className="relative flex h-1.5 w-1.5 shrink-0">
              {healthy && (
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 pulse-ring" />
              )}
              <span
                className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
                  healthy ? "bg-emerald-400" : connected ? "bg-amber-400" : "bg-rose-400"
                }`}
              />
            </span>
            {statusText}
          </div>
        </div>
      </button>

      {open && (
        <div
          className={`desktop-no-drag pop-in absolute left-0 right-0 top-full mt-2 rounded-2xl border p-2.5 shadow-2xl ${
            isDark
              ? "border-white/10 bg-[#18181b] shadow-black/50"
              : "border-zinc-200 bg-white shadow-zinc-300/70"
          }`}
          onClick={(event) => event.stopPropagation()}
        >
          <div className={`mb-2 text-[11px] font-medium ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>
            Connection
          </div>
          <div className="space-y-1.5">
            {services.map((service) => (
              <ServiceStatusRow
                key={service.label}
                label={service.label}
                value={service.value}
                isDark={isDark}
              />
            ))}
          </div>

          {connectionActions.length > 0 && (
            <div
              className="mt-3 grid gap-1.5"
              style={{ gridTemplateColumns: `repeat(${connectionActions.length}, minmax(0, 1fr))` }}
            >
              {connectionActions.map((action) => (
                <ConnectionActionButton
                  key={action.action}
                  isDark={isDark}
                  label={action.label}
                  onClick={() => onAction(action.action)}
                />
              ))}
            </div>
          )}

          {expanded && desktopStatus && (
            <div className={`mt-3 space-y-2 border-t pt-3 ${isDark ? "border-white/10" : "border-zinc-200"}`}>
              <ConnectionDetail label="Convex URL" value={desktopStatus.convexUrl} isDark={isDark} />
              <ConnectionDetail label="Text Boop" value={desktopStatus.phoneNumber} isDark={isDark} />
              <ConnectionDetail label="Public URL" value={desktopStatus.publicUrl} isDark={isDark} />
              <ConnectionDetail
                label="Expected webhook"
                value={desktopStatus.expectedWebhookUrl}
                isDark={isDark}
              />
              <ConnectionDetail
                label="Sendblue has"
                value={desktopStatus.registeredWebhookUrl}
                isDark={isDark}
              />
              <ConnectionDetail
                label="Webhook check"
                value={desktopStatus.webhookDetails}
                isDark={isDark}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ServiceStatusRow({
  label,
  value,
  isDark,
}: {
  label: string;
  value?: string;
  isDark: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
      <span className={isDark ? "text-zinc-400" : "text-zinc-600"}>{label}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(value)}`} />
        <span className={`truncate font-medium ${isDark ? "text-zinc-100" : "text-zinc-900"}`}>
          {statusLabel(value)}
        </span>
      </span>
    </div>
  );
}

function ConnectionActionButton({
  isDark,
  label,
  onClick,
}: {
  isDark: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 rounded-lg border px-2 text-[11px] font-medium ${
        isDark
          ? "border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
          : "border-zinc-200 bg-zinc-50 text-zinc-900 hover:bg-zinc-100"
      }`}
    >
      {label}
    </button>
  );
}

function ConnectionDetail({
  label,
  value,
  isDark,
}: {
  label: string;
  value?: string;
  isDark: boolean;
}) {
  return (
    <div className="min-w-0 text-xs">
      <div className={isDark ? "text-zinc-500" : "text-zinc-500"}>{label}</div>
      <div
        className={`mt-0.5 truncate mono font-medium ${
          value ? (isDark ? "text-zinc-200" : "text-zinc-800") : isDark ? "text-zinc-600" : "text-zinc-400"
        }`}
        title={value || "Not set"}
      >
        {value || "Not set"}
      </div>
    </div>
  );
}

function isDesktopStarting(status: DesktopStatus) {
  return (
    status.state === "starting" ||
    status.server === "starting" ||
    status.convex === "starting" ||
    status.dashboard === "starting"
  );
}

function isDesktopActive(status: DesktopStatus) {
  return (
    isDesktopStarting(status) ||
    status.state === "running" ||
    status.server === "running" ||
    status.convex === "running" ||
    status.dashboard === "running"
  );
}

function statusLabel(value?: string) {
  if (!value) return "Unknown";
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, " ");
}

function statusDotClass(value?: string) {
  if (value === "running" || value === "registered") return "bg-emerald-400";
  if (value === "starting" || value === "checking") return "bg-amber-400";
  if (value === "error" || value === "setup-required" || value === "mismatch" || value === "missing") {
    return "bg-rose-400";
  }
  if (value === "no-tunnel") return "bg-amber-400";
  if (value === "stopped") return "bg-zinc-500";
  return "bg-zinc-600";
}
