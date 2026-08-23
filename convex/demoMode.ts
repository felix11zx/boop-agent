import type { MutationCtx, QueryCtx } from "./_generated/server";

export const DEMO_PREFIX = "demo:";
export const DEMO_SETTING_KEY = "debug_demo_mode";
export const DEMO_COUNTS_SETTING_KEY = "debug_demo_counts";
export const DEMO_SCAN_LIMIT = 5000;

export function isDemoId(value?: string | null): boolean {
  return typeof value === "string" && value.startsWith(DEMO_PREFIX);
}

export async function isDemoModeEnabled(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", DEMO_SETTING_KEY))
    .unique();
  return row?.value === "true";
}

export function isDemoMessage(row: { conversationId?: string | null; agentId?: string | null }) {
  return isDemoId(row.conversationId) || isDemoId(row.agentId);
}

export function isDemoMemoryEvent(row: {
  conversationId?: string | null;
  memoryId?: string | null;
  agentId?: string | null;
}) {
  return isDemoId(row.conversationId) || isDemoId(row.memoryId) || isDemoId(row.agentId);
}

export function isDemoAutomationRun(row: {
  runId?: string | null;
  automationId?: string | null;
  agentId?: string | null;
}) {
  return isDemoId(row.runId) || isDemoId(row.automationId) || isDemoId(row.agentId);
}

export function isDemoUsageRecord(row: {
  conversationId?: string | null;
  agentId?: string | null;
  runId?: string | null;
}) {
  return isDemoId(row.conversationId) || isDemoId(row.agentId) || isDemoId(row.runId);
}
