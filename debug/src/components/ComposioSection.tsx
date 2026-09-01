import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { IntegrationLogo } from "../lib/branding.js";
import { CustomMcpSection } from "./CustomMcpSection.js";

type AuthMode = "managed" | "byo";

interface Connection {
  id: string;
  status: string;
  alias: string | null;
  accountLabel: string | null;
  accountEmail: string | null;
  accountName: string | null;
  accountAvatarUrl: string | null;
  createdAt: string | null;
}

interface Toolkit {
  slug: string;
  displayName: string;
  authMode: AuthMode;
  hasAuthConfig: boolean;
  logoUrl: string | null;
  description: string | null;
  toolCount: number | null;
  connections: Connection[];
}

interface ToolkitsResponse {
  enabled: boolean;
  toolkits: Toolkit[];
}

interface ToolSummary {
  slug: string;
  name: string;
  description?: string;
}

function hasActive(t: Toolkit): boolean {
  return t.connections.some((c) => c.status === "ACTIVE");
}

const STATUS_COLORS: Record<string, { dot: string; label: string; badge: string }> = {
  ACTIVE: {
    dot: "bg-emerald-400",
    label: "Connected",
    badge: "bg-emerald-400/10 text-emerald-500",
  },
  INITIATED: {
    dot: "bg-amber-400",
    label: "Pending",
    badge: "bg-amber-400/10 text-amber-500",
  },
  INITIALIZING: {
    dot: "bg-amber-400",
    label: "Initializing",
    badge: "bg-amber-400/10 text-amber-500",
  },
  EXPIRED: {
    dot: "bg-rose-400",
    label: "Expired",
    badge: "bg-rose-400/10 text-rose-500",
  },
  FAILED: {
    dot: "bg-rose-400",
    label: "Failed",
    badge: "bg-rose-400/10 text-rose-500",
  },
  INACTIVE: {
    dot: "bg-zinc-500",
    label: "Inactive",
    badge: "bg-zinc-400/10 text-zinc-500",
  },
};

interface NeedsAuthConfigInfo {
  slug: string;
  message: string;
  setupUrl: string;
}

// Per-toolkit guidance for BYO OAuth setup. Composio doesn't host a shared OAuth
// app for these; the user has to register one on the toolkit's developer portal,
// then paste the credentials into Composio's auth-configs page. Adding entries
// here makes the setup flow self-explanatory; missing entries fall back to a
// generic message and the Composio link.
const BYO_PORTALS: Record<string, { label: string; url: string; note?: string }> = {
  twitter: {
    label: "X (Twitter) Developer Portal",
    url: "https://developer.x.com/en/portal/dashboard",
    note: "Create a Project and App, then grab the OAuth 2.0 Client ID + Secret.",
  },
  linkedin: {
    label: "LinkedIn Developer Portal",
    url: "https://www.linkedin.com/developers/apps",
    note: "Create an App, request the scopes you need, copy the Client ID + Secret.",
  },
  salesforce: {
    label: "Salesforce - Connected Apps",
    url: "https://help.salesforce.com/s/articleView?id=connected_app_create.htm",
    note: "Create a Connected App in your org's Setup, copy the Consumer Key + Secret.",
  },
};

const COMPOSIO_DASHBOARD_URL = "https://dashboard.composio.dev";

const INTRO_DISMISSED_KEY = "boop:connections:intro-dismissed";
const TOAST_TIMEOUT_MS = 6000;

const DEMO_CREATED_AT = "2026-07-09T14:30:00.000Z";

const DEMO_TOOLS_BY_SLUG: Record<string, ToolSummary[]> = {
  gmail: [
    {
      slug: "GMAIL_SEARCH_EMAILS",
      name: "Search emails",
      description: "Search recent mail by sender, label, text, or date window.",
    },
    {
      slug: "GMAIL_FETCH_EMAIL",
      name: "Fetch email",
      description: "Read the full message and thread context for a selected email.",
    },
    {
      slug: "GMAIL_CREATE_EMAIL_DRAFT",
      name: "Create draft",
      description: "Prepare a reply and leave it pending for approval.",
    },
    {
      slug: "GMAIL_LIST_DRAFTS",
      name: "List drafts",
      description: "Review pending drafts before anything is sent.",
    },
  ],
  googlecalendar: [
    {
      slug: "GOOGLECALENDAR_LIST_EVENTS",
      name: "List events",
      description: "Find meetings, holds, conflicts, and free windows.",
    },
    {
      slug: "GOOGLECALENDAR_CREATE_EVENT",
      name: "Create event",
      description: "Create a calendar hold with location, dial-in, and notes.",
    },
    {
      slug: "GOOGLECALENDAR_UPDATE_EVENT",
      name: "Update event",
      description: "Move, rename, or annotate an existing calendar event.",
    },
  ],
  slack: [
    {
      slug: "SLACK_SEARCH_MESSAGES",
      name: "Search messages",
      description: "Find source messages across launch, support, and feedback channels.",
    },
    {
      slug: "SLACK_FETCH_CONVERSATION",
      name: "Fetch conversation",
      description: "Load surrounding thread context before summarizing.",
    },
    {
      slug: "SLACK_SEND_MESSAGE",
      name: "Send message",
      description: "Post a prepared update after explicit approval.",
    },
  ],
  linear: [
    {
      slug: "LINEAR_SEARCH_ISSUES",
      name: "Search issues",
      description: "Find launch blockers, owners, statuses, and labels.",
    },
    {
      slug: "LINEAR_CREATE_ISSUE",
      name: "Create issue",
      description: "File a bug or follow-up with source context attached.",
    },
    {
      slug: "LINEAR_UPDATE_ISSUE",
      name: "Update issue",
      description: "Patch status, owner, priority, and comments.",
    },
  ],
  notion: [
    {
      slug: "NOTION_SEARCH",
      name: "Search pages",
      description: "Find launch notes, briefs, customer docs, and decision logs.",
    },
    {
      slug: "NOTION_FETCH_PAGE",
      name: "Fetch page",
      description: "Read a page before citing or updating it.",
    },
    {
      slug: "NOTION_CREATE_PAGE",
      name: "Create page",
      description: "Create a structured brief, digest, or handoff note.",
    },
  ],
  github: [
    {
      slug: "GITHUB_SEARCH_CODE",
      name: "Search code",
      description: "Find implementation references and risky changes.",
    },
    {
      slug: "GITHUB_LIST_PULL_REQUESTS",
      name: "List pull requests",
      description: "Review open branches, checks, and pending feedback.",
    },
    {
      slug: "GITHUB_CREATE_ISSUE",
      name: "Create issue",
      description: "Capture a bug with reproduction notes and owner.",
    },
  ],
  googledrive: [
    {
      slug: "GOOGLEDRIVE_SEARCH",
      name: "Search Drive",
      description: "Find source docs, spreadsheets, receipts, and planning files.",
    },
    {
      slug: "GOOGLEDRIVE_FETCH_FILE",
      name: "Fetch file",
      description: "Read a selected document before summarizing or linking it.",
    },
  ],
};

function demoConnection(
  slug: string,
  alias: string,
  label = alias,
): Connection {
  return {
    id: `demo_${slug}_${alias.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    status: "ACTIVE",
    alias,
    accountLabel: label,
    accountEmail: null,
    accountName: label,
    accountAvatarUrl: null,
    createdAt: DEMO_CREATED_AT,
  };
}

const DEMO_TOOLKITS_RESPONSE: ToolkitsResponse = {
  enabled: true,
  toolkits: [
    {
      slug: "gmail",
      displayName: "Gmail",
      authMode: "managed",
      hasAuthConfig: true,
      logoUrl: null,
      description: "Priority inbox search, thread reading, and approval-based draft creation.",
      toolCount: DEMO_TOOLS_BY_SLUG.gmail.length,
      connections: [demoConnection("gmail", "Primary inbox"), demoConnection("gmail", "Support inbox")],
    },
    {
      slug: "googlecalendar",
      displayName: "Google Calendar",
      authMode: "managed",
      hasAuthConfig: true,
      logoUrl: null,
      description: "Calendar reads, conflict checks, tentative holds, and meeting updates.",
      toolCount: DEMO_TOOLS_BY_SLUG.googlecalendar.length,
      connections: [demoConnection("googlecalendar", "Work calendar")],
    },
    {
      slug: "linear",
      displayName: "Linear",
      authMode: "managed",
      hasAuthConfig: true,
      logoUrl: null,
      description: "Issue search, blocker sweeps, bug filing, and status updates.",
      toolCount: DEMO_TOOLS_BY_SLUG.linear.length,
      connections: [demoConnection("linear", "Product workspace")],
    },
    {
      slug: "slack",
      displayName: "Slack",
      authMode: "managed",
      hasAuthConfig: true,
      logoUrl: null,
      description: "Source-message search and thread context for support and launch channels.",
      toolCount: DEMO_TOOLS_BY_SLUG.slack.length,
      connections: [demoConnection("slack", "Team workspace")],
    },
    {
      slug: "notion",
      displayName: "Notion",
      authMode: "managed",
      hasAuthConfig: true,
      logoUrl: null,
      description: "Search and write structured briefs, checklists, and decision logs.",
      toolCount: DEMO_TOOLS_BY_SLUG.notion.length,
      connections: [demoConnection("notion", "Launch workspace")],
    },
    {
      slug: "github",
      displayName: "GitHub",
      authMode: "managed",
      hasAuthConfig: true,
      logoUrl: null,
      description: "Code search, pull request checks, and issue creation for engineering follow-up.",
      toolCount: DEMO_TOOLS_BY_SLUG.github.length,
      connections: [demoConnection("github", "Engineering org")],
    },
    {
      slug: "googledrive",
      displayName: "Google Drive",
      authMode: "managed",
      hasAuthConfig: true,
      logoUrl: null,
      description: "Planning docs, sheets, receipts, and launch artifacts.",
      toolCount: DEMO_TOOLS_BY_SLUG.googledrive.length,
      connections: [demoConnection("googledrive", "Shared Drive")],
    },
  ],
};

const DEMO_CONNECTED_TOOLKITS_BY_SLUG = new Map(
  DEMO_TOOLKITS_RESPONSE.toolkits.map((toolkit) => [toolkit.slug, toolkit]),
);

function buildDemoToolkitsResponse(catalog: ToolkitsResponse | null): ToolkitsResponse {
  if (!catalog || catalog.toolkits.length === 0) return DEMO_TOOLKITS_RESPONSE;

  const bySlug = new Map<string, Toolkit>();
  for (const toolkit of catalog.toolkits) {
    const demoToolkit = DEMO_CONNECTED_TOOLKITS_BY_SLUG.get(toolkit.slug);
    bySlug.set(toolkit.slug, {
      ...toolkit,
      authMode: "managed",
      hasAuthConfig: true,
      connections: demoToolkit?.connections ?? [],
      toolCount: toolkit.toolCount ?? demoToolkit?.toolCount ?? null,
    });
  }

  for (const toolkit of DEMO_TOOLKITS_RESPONSE.toolkits) {
    if (!bySlug.has(toolkit.slug)) bySlug.set(toolkit.slug, toolkit);
  }

  return {
    enabled: true,
    toolkits: [...bySlug.values()].sort((a, b) => {
      const aConnected = hasActive(a);
      const bConnected = hasActive(b);
      if (aConnected !== bConnected) return aConnected ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    }),
  };
}

const DEMO_EXPANDED_TOOLKITS = Object.fromEntries(
  DEMO_TOOLKITS_RESPONSE.toolkits.map((toolkit) => [toolkit.slug, true]),
);

interface ToastState {
  id: number;
  message: string;
  tone: "error" | "info";
}

function Toast({
  toast,
  onDismiss,
  isDark,
}: {
  toast: ToastState;
  onDismiss: () => void;
  isDark: boolean;
}) {
  const tone = toast.tone === "error"
    ? isDark
      ? "bg-rose-500/10 border-rose-500/30 text-rose-200"
      : "bg-rose-50 border-rose-200 text-rose-900"
    : isDark
      ? "border-white/10 bg-[#202024] text-zinc-200"
      : "border-zinc-200 bg-white text-zinc-700";
  return (
    <div
      role="status"
      className={`fixed bottom-4 right-4 z-50 max-w-sm rounded-2xl border px-3 py-2 text-xs shadow-lg fade-in ${tone}`}
    >
      <div className="flex items-start gap-3">
        <span className="flex-1 leading-snug">{toast.message}</span>
        <button
          onClick={onDismiss}
          className="text-[11px] underline opacity-70 hover:opacity-100 shrink-0"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function IntroCard({ isDark, onDismiss }: { isDark: boolean; onDismiss: () => void }) {
  return (
    <div
      className={`rounded-2xl border px-4 py-4 ${
        isDark
          ? "border-white/10 bg-white/5 text-zinc-300"
          : "border-zinc-200 bg-white text-zinc-600 shadow-sm shadow-zinc-200/50"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 text-xs leading-relaxed">
          <div className={`mb-1 text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-900"}`}>
            Connect your accounts
          </div>
          <p className="mb-2">
            Each connected toolkit becomes available to the agent when a task needs it.
          </p>
          <ul className="space-y-1">
            <li>
              <span
                className={`mr-2 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  isDark ? "bg-emerald-400/10 text-emerald-400" : "bg-emerald-50 text-emerald-700"
                }`}
              >
                Ready to connect
              </span>
              Click Connect, log into your account in the popup, you're done.
            </li>
            <li>
              <span
                className={`mr-2 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  isDark ? "bg-amber-400/10 text-amber-400" : "bg-amber-50 text-amber-700"
                }`}
              >
                Needs auth config
              </span>
              Toolkit's terms don't allow a shared OAuth app, so you have to register your own
              once. The card shows the steps.
            </li>
          </ul>
        </div>
        <button
          onClick={onDismiss}
          className={`shrink-0 rounded-xl px-2 py-1 text-[11px] ${
            isDark ? "text-zinc-500 hover:bg-white/5 hover:text-zinc-300" : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          }`}
        >
          Hide
        </button>
      </div>
    </div>
  );
}

export function ComposioSection({ isDark }: { isDark: boolean }) {
  const demoStatus = useQuery(api.demo.status);
  const demoModeEnabled = demoStatus?.enabled ?? false;
  const [data, setData] = useState<ToolkitsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [needsAuthConfig, setNeedsAuthConfig] = useState<NeedsAuthConfigInfo | null>(null);
  const [showIntro, setShowIntro] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(INTRO_DISMISSED_KEY) !== "1";
  });
  const dismissIntro = useCallback(() => {
    setShowIntro(false);
    try {
      window.localStorage.setItem(INTRO_DISMISSED_KEY, "1");
    } catch {
      /* ignore private mode, etc. */
    }
  }, []);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [toolsBySlug, setToolsBySlug] = useState<
    Record<string, ToolSummary[] | "loading" | "error">
  >({});
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(null);
  }, []);
  const showToast = useCallback((message: string, tone: ToastState["tone"] = "error") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), message, tone });
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, TOAST_TIMEOUT_MS);
  }, []);
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );
  // OAuth popup polling interval, kept in a ref so we can clear it on unmount
  // (prevents an orphan interval firing fetches after the panel closes).
  const authPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (authPollRef.current) clearInterval(authPollRef.current);
    },
    [],
  );

  const fetchToolkits = useCallback(async () => {
    setLoaded(false);
    try {
      const endpoint = demoModeEnabled
        ? "/api/composio/toolkits?catalog=all"
        : "/api/composio/toolkits";
      const r = await fetch(endpoint);
      const json = (await r.json()) as ToolkitsResponse;
      setData(json);
    } catch {
      setData({ enabled: false, toolkits: [] });
    } finally {
      setLoaded(true);
    }
  }, [demoModeEnabled]);

  useEffect(() => {
    fetchToolkits();
  }, [fetchToolkits]);

  const connect = useCallback(
    async (slug: string) => {
      setBusy(slug);
      setNeedsAuthConfig(null);
      try {
        const r = await fetch(`/api/composio/toolkits/${slug}/authorize`, { method: "POST" });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          if (err?.needsAuthConfig) {
            setNeedsAuthConfig({
              slug,
              message: err.error,
              setupUrl: err.setupUrl ?? COMPOSIO_DASHBOARD_URL,
            });
            setBusy(null);
            return;
          }
          showToast(`Authorize failed: ${err?.error ?? r.statusText}`);
          setBusy(null);
          return;
        }
        const { redirectUrl } = await r.json();
        if (!redirectUrl) {
          showToast("Composio did not return a redirect URL.");
          setBusy(null);
          return;
        }
        const w = 600;
        const h = 700;
        const left = window.screenX + (window.outerWidth - w) / 2;
        const top = window.screenY + (window.outerHeight - h) / 2;
        const popup = window.open(
          redirectUrl,
          "composio-auth",
          `width=${w},height=${h},left=${left},top=${top}`,
        );
        // Replace any prior poll. You'd have to spam Connect for this to matter.
        if (authPollRef.current) clearInterval(authPollRef.current);
        authPollRef.current = setInterval(async () => {
          if (!popup || popup.closed) {
            if (authPollRef.current) {
              clearInterval(authPollRef.current);
              authPollRef.current = null;
            }
            try {
              await fetch("/api/composio/refresh", { method: "POST" });
            } catch {
              /* ignore */
            }
            await fetchToolkits();
            setBusy(null);
          }
        }, 800);
      } catch (err) {
        showToast(`Authorize failed: ${String(err)}`);
        setBusy(null);
      }
    },
    [fetchToolkits, showToast],
  );

  const disconnect = useCallback(
    async (slug: string, connectionId: string) => {
      setBusy(`${slug}:${connectionId}`);
      try {
        const r = await fetch(`/api/composio/toolkits/${slug}/disconnect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          showToast(`Disconnect failed: ${err?.error ?? r.statusText}`);
          return;
        }
        await fetchToolkits();
      } catch (err) {
        showToast(`Disconnect failed: ${String(err)}`);
      } finally {
        setBusy(null);
      }
    },
    [fetchToolkits, showToast],
  );

  const rename = useCallback(
    async (connectionId: string, alias: string): Promise<boolean> => {
      try {
        const r = await fetch(`/api/composio/connections/${connectionId}/rename`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alias }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          showToast(`Rename failed: ${err?.error ?? r.statusText}`);
          return false;
        }
        await fetchToolkits();
        return true;
      } catch (err) {
        showToast(`Rename failed: ${String(err)}`);
        return false;
      }
    },
    [fetchToolkits, showToast],
  );

  const toggleTools = useCallback(
    async (slug: string) => {
      const willExpand = !expanded[slug];
      setExpanded((prev) => ({ ...prev, [slug]: willExpand }));
      if (!willExpand) return;
      if (toolsBySlug[slug] && toolsBySlug[slug] !== "error") return;
      setToolsBySlug((prev) => ({ ...prev, [slug]: "loading" }));
      try {
        const r = await fetch(`/api/composio/toolkits/${slug}/tools`);
        if (!r.ok) throw new Error(r.statusText);
        const json = (await r.json()) as { tools: ToolSummary[] };
        setToolsBySlug((prev) => ({ ...prev, [slug]: json.tools }));
      } catch {
        setToolsBySlug((prev) => ({ ...prev, [slug]: "error" }));
      }
    },
    [expanded, toolsBySlug],
  );

  const cardBg = isDark
    ? "border-white/10 bg-[#202024] shadow-black/20"
    : "border-zinc-200 bg-white shadow-zinc-200/50";
  const muted = isDark ? "text-zinc-500" : "text-zinc-400";
  const visibleData = demoModeEnabled ? buildDemoToolkitsResponse(data) : data;
  const visibleLoaded = loaded;
  const visibleExpanded = demoModeEnabled ? DEMO_EXPANDED_TOOLKITS : expanded;
  const visibleToolsBySlug = demoModeEnabled
    ? { ...DEMO_TOOLS_BY_SLUG, ...toolsBySlug }
    : toolsBySlug;
  const handleConnect = demoModeEnabled
    ? (slug: string) => showToast(`${slug} is already connected in demo mode.`, "info")
    : connect;
  const handleDisconnect = demoModeEnabled
    ? (_slug: string, _connectionId: string) =>
        showToast("Demo connections are read-only. Turn off demo mode to manage real accounts.", "info")
    : disconnect;
  const handleRename = demoModeEnabled
    ? async () => {
        showToast("Demo account labels are fixed for the recording dataset.", "info");
        return false;
      }
    : rename;

  const activeCount =
    visibleData?.toolkits.reduce((n, t) => n + t.connections.filter((c) => c.status === "ACTIVE").length, 0) ?? 0;

  return (
    <section className="mx-auto max-w-[1040px] space-y-5 pb-10">
      <SectionHeader
        title="Connections"
        count={activeCount}
        isDark={isDark}
        hint={
          !demoModeEnabled && visibleData?.enabled === false
            ? "Set COMPOSIO_API_KEY in .env.local"
            : undefined
        }
      />

      {showIntro && !demoModeEnabled && visibleData?.enabled !== false && (
        <IntroCard isDark={isDark} onDismiss={dismissIntro} />
      )}

      {needsAuthConfig && (
        <div
          className={`rounded-2xl border px-4 py-4 text-sm ${
            isDark
              ? "bg-amber-500/5 border-amber-500/30 text-amber-200"
              : "bg-amber-50 border-amber-200 text-amber-900"
          }`}
        >
          <div className="font-medium mb-1">
            <span className="mono">{needsAuthConfig.slug}</span> needs a one-time auth config
          </div>
          <div className="text-xs opacity-90 mb-2">
            Composio doesn't host a managed OAuth app for this toolkit, so you have to bring your
            own. One-time setup (takes a few minutes): create an OAuth app on the toolkit's
            developer portal, then register it as an Auth Config in Composio's dashboard. After
            that, come back here and click Connect.
          </div>
          <div className="flex items-center gap-3">
            <a
              href={needsAuthConfig.setupUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl px-2 py-1 text-xs font-medium text-amber-700 underline dark:text-amber-300"
            >
              Open Composio Auth Configs
            </a>
            <button
              onClick={() => setNeedsAuthConfig(null)}
              className={`rounded-xl px-2 py-1 text-xs ${isDark ? "text-amber-200/80 hover:bg-amber-400/10" : "text-amber-800/80 hover:bg-amber-100"}`}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {visibleData?.enabled === false ? (
        <div className={`rounded-2xl border px-4 py-6 text-sm shadow-sm ${cardBg} ${muted}`}>
          Add <code>COMPOSIO_API_KEY</code> to <code>.env.local</code> and restart the server to
          connect integrations like Gmail, Slack, GitHub, Linear, Notion, and more. Get a key at{" "}
          <a
            href="https://app.composio.dev/developers"
            target="_blank"
            rel="noreferrer"
            className={isDark ? "text-zinc-200 underline" : "text-zinc-700 underline"}
          >
            app.composio.dev/developers
          </a>
          .
        </div>
      ) : !visibleLoaded ? (
        <div className="grid gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className={`h-20 rounded-2xl border shadow-sm ${cardBg} shimmer`} />
          ))}
        </div>
      ) : (
        (() => {
          const toolkits = visibleData?.toolkits ?? [];
          const needsSetup = toolkits.filter(
            (t) => !hasActive(t) && t.authMode === "byo" && !t.hasAuthConfig,
          );
          const ready = toolkits.filter((t) => !needsSetup.includes(t));
          return (
            <div className="space-y-6">
              {ready.length > 0 && (
                <SubsectionGrid
                  label={demoModeEnabled ? "Composio catalog" : "Ready to connect"}
                  hint={demoModeEnabled ? "Full Composio catalog; demo connects a few accounts" : "Composio-managed OAuth, click Connect"}
                  isDark={isDark}
                >
                  {ready.map((t) => (
                    <ToolkitCard
                      key={t.slug}
                      t={t}
                      busy={busy}
                      cardBg={cardBg}
                      muted={muted}
                      isDark={isDark}
                      demoMode={demoModeEnabled}
                      expanded={!!visibleExpanded[t.slug]}
                      tools={visibleToolsBySlug[t.slug]}
                      onConnect={handleConnect}
                      onDisconnect={handleDisconnect}
                      onRename={handleRename}
                      onToggleTools={toggleTools}
                    />
                  ))}
                </SubsectionGrid>
              )}
              {needsSetup.length > 0 && (
                <SubsectionGrid
                  label="Needs one-time auth config"
                  hint="Toolkit requires your own OAuth app"
                  isDark={isDark}
                >
                  {needsSetup.map((t) => (
                    <ToolkitCard
                      key={t.slug}
                      t={t}
                      busy={busy}
                      cardBg={cardBg}
                      muted={muted}
                      isDark={isDark}
                      demoMode={demoModeEnabled}
                      expanded={!!visibleExpanded[t.slug]}
                      tools={visibleToolsBySlug[t.slug]}
                      onConnect={handleConnect}
                      onDisconnect={handleDisconnect}
                      onRename={handleRename}
                      onToggleTools={toggleTools}
                    />
                  ))}
                </SubsectionGrid>
              )}
            </div>
          );
        })()
      )}
      <CustomMcpSection isDark={isDark} />
      {toast && <Toast toast={toast} onDismiss={dismissToast} isDark={isDark} />}
    </section>
  );
}

function ToolkitCard({
  t,
  busy,
  cardBg,
  muted,
  isDark,
  demoMode,
  expanded,
  tools,
  onConnect,
  onDisconnect,
  onRename,
  onToggleTools,
}: {
  t: Toolkit;
  busy: string | null;
  cardBg: string;
  muted: string;
  isDark: boolean;
  demoMode?: boolean;
  expanded: boolean;
  tools: ToolSummary[] | "loading" | "error" | undefined;
  onConnect: (slug: string) => void;
  onDisconnect: (slug: string, connectionId: string) => void;
  onRename: (connectionId: string, alias: string) => Promise<boolean>;
  onToggleTools: (slug: string) => void;
}) {
  const hasConnections = t.connections.length > 0;
  const needsSetup = t.authMode === "byo" && !t.hasAuthConfig && !hasConnections;
  const connectBusy = busy === t.slug;

  return (
    <div className={`rounded-2xl border px-4 py-3.5 shadow-sm fade-in ${cardBg}`}>
      <div className="flex items-center gap-4">
        <IntegrationLogo raw={t.slug} logoUrl={t.logoUrl ?? undefined} size={32} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`text-sm font-medium ${
                isDark ? "text-zinc-100" : "text-zinc-900"
              }`}
            >
              {t.displayName}
            </span>
            <span className={`text-xs mono ${muted}`}>{t.slug}</span>
            {t.authMode === "byo" && t.hasAuthConfig && !hasConnections && (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                  isDark ? "bg-zinc-100/10 text-zinc-300" : "bg-zinc-100 text-zinc-700"
                }`}
              >
                BYO configured
              </span>
            )}
            {t.toolCount != null && t.toolCount > 0 && (
              <button
                onClick={() => onToggleTools(t.slug)}
                className={`rounded-lg px-1 py-0.5 text-[10px] mono ${muted} ${isDark ? "hover:bg-white/5 hover:text-zinc-200" : "hover:bg-zinc-100 hover:text-zinc-700"}`}
              >
                {expanded ? "Hide" : "Show"} {t.toolCount} tools
              </button>
            )}
          </div>
          {t.description && (
            <p className={`text-xs ${muted} leading-snug mt-0.5 line-clamp-2`}>
              {t.description}
            </p>
          )}
          {!hasConnections && (
            <span className={`text-xs ${muted}`}>
              {needsSetup ? "Auth config required" : "Not connected"}
            </span>
          )}
        </div>
        {!demoMode && !hasConnections && !needsSetup && (
          <button
            onClick={() => onConnect(t.slug)}
            disabled={connectBusy}
            className={`shrink-0 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors ${
              connectBusy
                ? isDark
                  ? "bg-zinc-700 text-zinc-400"
                  : "bg-zinc-200 text-zinc-500"
                : isDark
                  ? "bg-zinc-100 text-zinc-950 hover:bg-white"
                  : "bg-zinc-950 text-white hover:bg-zinc-800"
            }`}
          >
            {connectBusy ? "Connecting…" : "Connect"}
          </button>
        )}
        {!demoMode && needsSetup && (
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${
              isDark ? "bg-amber-400/10 text-amber-400" : "bg-amber-50 text-amber-700"
            }`}
          >
            Setup needed
          </span>
        )}
      </div>

      {!demoMode && needsSetup && (
        <ByoSetupSteps slug={t.slug} isDark={isDark} muted={muted} onConnect={onConnect} />
      )}

      {hasConnections && (
        <div className="mt-3 space-y-1.5">
          {t.connections.map((c, i) => (
            <ConnectionRow
              key={c.id}
              slug={t.slug}
              conn={c}
              index={i}
              busy={busy === `${t.slug}:${c.id}`}
              isDark={isDark}
              muted={muted}
              demoMode={demoMode}
              onDisconnect={onDisconnect}
              onRename={onRename}
            />
          ))}
          {!demoMode && (
            <button
              onClick={() => onConnect(t.slug)}
              disabled={connectBusy}
              className={`rounded-xl px-2.5 py-1.5 text-xs transition-colors ${
                isDark
                  ? "border border-white/10 text-zinc-300 hover:bg-white/5"
                  : "border border-zinc-200 text-zinc-600 hover:bg-zinc-100"
              } ${connectBusy ? "opacity-50" : ""}`}
            >
              {connectBusy ? "Connecting…" : "+ Add another account"}
            </button>
          )}
        </div>
      )}

      {expanded && <ToolList tools={tools} isDark={isDark} muted={muted} />}
    </div>
  );
}

function ConnectionRow({
  slug,
  conn,
  index,
  busy,
  isDark,
  muted,
  demoMode,
  onDisconnect,
  onRename,
}: {
  slug: string;
  conn: Connection;
  index: number;
  busy: boolean;
  isDark: boolean;
  muted: string;
  demoMode?: boolean;
  onDisconnect: (slug: string, connectionId: string) => void;
  onRename: (connectionId: string, alias: string) => Promise<boolean>;
}) {
  const status = STATUS_COLORS[(conn.status ?? "").toUpperCase()] ?? STATUS_COLORS.INACTIVE;
  const primary = conn.alias || conn.accountLabel || conn.accountEmail || conn.accountName || `Account ${index + 1}`;
  const secondary =
    conn.alias && conn.accountEmail
      ? conn.accountEmail
      : conn.accountName && conn.accountEmail && primary !== conn.accountEmail
        ? conn.accountEmail
        : null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conn.alias ?? "");
  const [saving, setSaving] = useState(false);
  const submittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const startEdit = () => {
    setDraft(conn.alias ?? "");
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft(conn.alias ?? "");
  };
  const submit = async () => {
    if (submittingRef.current) return;
    const alias = draft.trim();
    if (!alias || alias === (conn.alias ?? "")) {
      cancelEdit();
      return;
    }
    submittingRef.current = true;
    setSaving(true);
    const ok = await onRename(conn.id, alias);
    setSaving(false);
    submittingRef.current = false;
    if (ok) setEditing(false);
  };
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  return (
    <div
      className={`flex items-center gap-2 rounded-xl px-2.5 py-1.5 ${
        isDark
          ? "border border-white/10 bg-[#17171a]"
          : "border border-zinc-200 bg-zinc-50"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
      {conn.accountAvatarUrl && (
        <img
          src={conn.accountAvatarUrl}
          alt=""
          width={16}
          height={16}
          className="rounded-full"
          loading="lazy"
        />
      )}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") cancelEdit();
          }}
          onBlur={() => void submit()}
          placeholder="work, personal, …"
          maxLength={50}
          disabled={saving}
          aria-label="Account label"
          className={`w-40 rounded-lg border px-1.5 py-0.5 text-xs font-medium outline-none ${
            isDark
              ? "border-white/10 bg-black/20 text-zinc-100 focus:border-zinc-400"
              : "border-zinc-200 bg-white text-zinc-800 focus:border-zinc-400"
          }`}
        />
      ) : (
        <span className={`max-w-[18rem] truncate text-xs font-medium ${isDark ? "text-zinc-200" : "text-zinc-700"}`}>
          {primary}
        </span>
      )}
      {secondary && !editing && (
        <span className={`text-[11px] ${muted} truncate max-w-[14rem]`}>{secondary}</span>
      )}
      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${status.badge}`}>
        {status.label}
      </span>
      <span className={`text-[10px] mono ${muted} truncate`}>{conn.id}</span>
      <div className="flex-1" />
      {!demoMode && (
        editing ? (
          <>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void submit()}
              disabled={saving}
              className={`text-[11px] underline ${
                isDark ? "text-zinc-300 hover:text-white" : "text-zinc-700 hover:text-zinc-950"
              } disabled:opacity-50`}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={cancelEdit}
              disabled={saving}
              className={`text-[11px] underline ${muted} hover:text-rose-500 disabled:opacity-50`}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={startEdit}
            className={`rounded-lg px-1.5 py-0.5 text-[11px] ${muted} ${isDark ? "hover:bg-white/5 hover:text-zinc-200" : "hover:bg-zinc-100 hover:text-zinc-800"}`}
          >
            Rename
          </button>
        )
      )}
      {!demoMode && (
        <button
          onClick={() => onDisconnect(slug, conn.id)}
          disabled={busy || editing}
          className={`rounded-lg px-2 py-0.5 text-[11px] transition-colors ${
            isDark
              ? "bg-white/5 text-zinc-300 hover:bg-white/10 disabled:opacity-50"
              : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300 disabled:opacity-50"
          }`}
        >
          {busy ? "…" : "Disconnect"}
        </button>
      )}
    </div>
  );
}

function ByoSetupSteps({
  slug,
  isDark,
  muted,
  onConnect,
}: {
  slug: string;
  isDark: boolean;
  muted: string;
  onConnect: (slug: string) => void;
}) {
  const portal = BYO_PORTALS[slug];
  const wrapClass = `mt-3 border-t pt-3 ${isDark ? "border-white/10" : "border-zinc-200"}`;
  const linkClass = isDark
    ? "text-zinc-200 hover:text-white underline"
    : "text-zinc-700 hover:text-zinc-950 underline";
  const stepNumberClass = `inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-semibold mr-2 shrink-0 ${
    isDark ? "bg-amber-400/15 text-amber-300" : "bg-amber-100 text-amber-800"
  }`;
  return (
    <div className={wrapClass}>
      <div className={`mb-2 text-[11px] font-medium ${isDark ? "text-zinc-300" : "text-zinc-700"}`}>
        One-time setup (~5 min):
      </div>
      <ol className="space-y-1.5">
        <li className={`flex items-start text-xs ${isDark ? "text-zinc-300" : "text-zinc-700"}`}>
          <span className={stepNumberClass}>1</span>
          <span className="leading-snug">
            {portal ? (
              <>
                Register an OAuth app at{" "}
                <a href={portal.url} target="_blank" rel="noreferrer" className={linkClass}>
                  {portal.label}
                </a>
                {portal.note && <span className={`block text-[11px] mt-0.5 ${muted}`}>{portal.note}</span>}
              </>
            ) : (
              <>Register an OAuth app on this toolkit's developer portal and copy the Client ID + Secret.</>
            )}
          </span>
        </li>
        <li className={`flex items-start text-xs ${isDark ? "text-zinc-300" : "text-zinc-700"}`}>
          <span className={stepNumberClass}>2</span>
          <span className="leading-snug">
            In{" "}
            <a href={COMPOSIO_DASHBOARD_URL} target="_blank" rel="noreferrer" className={linkClass}>
              Composio Dashboard
            </a>
            : Toolkits, search <span className="mono">{slug}</span>, Add to project, then paste those credentials.
          </span>
        </li>
        <li className={`flex items-start text-xs ${isDark ? "text-zinc-300" : "text-zinc-700"}`}>
          <span className={stepNumberClass}>3</span>
          <span className="leading-snug">
            Come back here and{" "}
            <button
              onClick={() => onConnect(slug)}
              className={`${linkClass} bg-transparent p-0 border-0 cursor-pointer`}
            >
              click Connect
            </button>{" "}
            to run OAuth.
          </span>
        </li>
      </ol>
    </div>
  );
}

function ToolList({
  tools,
  isDark,
  muted,
}: {
  tools: ToolSummary[] | "loading" | "error" | undefined;
  isDark: boolean;
  muted: string;
}) {
  const wrapClass = `mt-3 border-t pt-3 ${isDark ? "border-white/10" : "border-zinc-200"}`;
  if (!tools || tools === "loading") {
    return <div className={`${wrapClass} text-xs ${muted}`}>Loading tools…</div>;
  }
  if (tools === "error") {
    return <div className={`${wrapClass} text-xs text-rose-500`}>Failed to load tools.</div>;
  }
  if (tools.length === 0) {
    return <div className={`${wrapClass} text-xs ${muted}`}>No tools available.</div>;
  }
  return (
    <div className={wrapClass}>
      <div className="grid gap-1.5 max-h-64 overflow-y-auto pr-2">
        {tools.map((tool) => (
          <div
            key={tool.slug}
            className={`text-xs ${isDark ? "text-zinc-300" : "text-zinc-600"}`}
          >
            <span className="mono">{tool.slug}</span>
            {tool.description && (
              <span className={`ml-2 ${muted}`}>{truncate(tool.description, 120)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1).trimEnd() + "…";
}

function SubsectionGrid({
  label,
  hint,
  children,
  isDark,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  isDark: boolean;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <h3
          className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${
            isDark ? "text-zinc-400" : "text-zinc-500"
          }`}
        >
          {label}
        </h3>
        {hint && (
          <span className={`text-[10px] ${isDark ? "text-zinc-600" : "text-zinc-400"}`}>
            {hint}
          </span>
        )}
      </div>
      <div className="grid gap-3">{children}</div>
    </div>
  );
}

function SectionHeader({
  title,
  count,
  hint,
  isDark,
}: {
  title: string;
  count: number;
  hint?: string;
  isDark: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div
          className={`text-[11px] font-medium uppercase tracking-[0.08em] ${
            isDark ? "text-zinc-500" : "text-zinc-400"
          }`}
        >
          Integrations
        </div>
        <h2
          className={`mt-1 text-[22px] font-semibold tracking-normal ${
            isDark ? "text-zinc-50" : "text-zinc-950"
          }`}
        >
          {title}
        </h2>
        <p className={`mt-1 text-sm ${isDark ? "text-zinc-400" : "text-zinc-500"}`}>
          Connect accounts the agent can use for delegated work.
        </p>
        {hint && (
          <p className={`mt-1 text-xs ${isDark ? "text-amber-300" : "text-amber-700"}`}>
            {hint}
          </p>
        )}
      </div>
      <span
        className={`inline-flex w-fit items-center rounded-2xl border px-2.5 py-1 text-xs mono ${
          isDark
            ? "border-white/10 bg-white/5 text-zinc-400"
            : "border-zinc-200 bg-white text-zinc-500"
        }`}
      >
        {count} active
      </span>
    </div>
  );
}
