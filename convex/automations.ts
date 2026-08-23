import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { DEMO_SCAN_LIMIT, isDemoAutomationRun, isDemoId, isDemoModeEnabled } from "./demoMode";

export const create = mutation({
  args: {
    automationId: v.string(),
    name: v.string(),
    task: v.string(),
    integrations: v.array(v.string()),
    schedule: v.string(),
    timezone: v.optional(v.string()),
    conversationId: v.optional(v.string()),
    notifyConversationId: v.optional(v.string()),
    nextRunAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", args.automationId))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("automations", {
      ...args,
      enabled: true,
      createdAt: Date.now(),
    });
  },
});

async function readAutomations(
  ctx: QueryCtx,
  enabledOnly: boolean | undefined,
  demoOnly: boolean,
) {
  const rows = enabledOnly
    ? await ctx.db
        .query("automations")
        .withIndex("by_enabled", (q) => q.eq("enabled", true))
        .order("desc")
        .take(DEMO_SCAN_LIMIT)
    : await ctx.db.query("automations").order("desc").take(DEMO_SCAN_LIMIT);
  return rows.filter((automation) => isDemoId(automation.automationId) === demoOnly);
}

export const list = query({
  args: { enabledOnly: v.optional(v.boolean()) },
  handler: async (ctx, args) => readAutomations(ctx, args.enabledOnly, false),
});

export const listForDashboard = query({
  args: { enabledOnly: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    return readAutomations(ctx, args.enabledOnly, await isDemoModeEnabled(ctx));
  },
});

export const get = query({
  args: { automationId: v.string() },
  handler: async (ctx, args) => {
    if (isDemoId(args.automationId)) return null;
    return await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", args.automationId))
      .unique();
  },
});

export const getForDashboard = query({
  args: { automationId: v.string() },
  handler: async (ctx, args) => {
    if (isDemoId(args.automationId) !== (await isDemoModeEnabled(ctx))) return null;
    return await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", args.automationId))
      .unique();
  },
});

export const setEnabled = mutation({
  args: { automationId: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const auto = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", args.automationId))
      .unique();
    if (!auto) return null;
    await ctx.db.patch(auto._id, { enabled: args.enabled });
    return auto._id;
  },
});

export const remove = mutation({
  args: { automationId: v.string() },
  handler: async (ctx, args) => {
    const auto = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", args.automationId))
      .unique();
    if (!auto) return null;
    await ctx.db.delete(auto._id);
    return auto._id;
  },
});

export const markRan = mutation({
  args: {
    automationId: v.string(),
    lastRunAt: v.number(),
    nextRunAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auto = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", args.automationId))
      .unique();
    if (!auto) return null;
    await ctx.db.patch(auto._id, {
      lastRunAt: args.lastRunAt,
      nextRunAt: args.nextRunAt,
    });
    return auto._id;
  },
});

// Claim a due automation and create its run in the same transaction. The
// server polls more frequently than an automation may take to finish, so
// advancing nextRunAt only after the worker returns would start duplicates on
// every poll (and on every server instance).
export const claimDueRun = mutation({
  args: {
    automationId: v.string(),
    runId: v.string(),
    claimedAt: v.number(),
    nextRunAt: v.number(),
  },
  handler: async (ctx, args) => {
    const auto = await ctx.db
      .query("automations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", args.automationId))
      .unique();
    if (
      !auto ||
      !auto.enabled ||
      auto.nextRunAt === undefined ||
      auto.nextRunAt > args.claimedAt
    ) {
      return null;
    }

    await ctx.db.patch(auto._id, {
      lastRunAt: args.claimedAt,
      nextRunAt: args.nextRunAt,
    });
    await ctx.db.insert("automationRuns", {
      runId: args.runId,
      automationId: args.automationId,
      status: "running",
      startedAt: args.claimedAt,
    });
    return auto._id;
  },
});

export const createRun = mutation({
  args: {
    runId: v.string(),
    automationId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("automationRuns", {
      ...args,
      status: "running",
      startedAt: Date.now(),
    });
  },
});

export const updateRun = mutation({
  args: {
    runId: v.string(),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    agentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("automationRuns")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .unique();
    if (!run) return null;
    const completed = args.status !== "running";
    const { runId: _runId, ...patch } = args;
    await ctx.db.patch(run._id, {
      ...patch,
      ...(completed ? { completedAt: Date.now() } : {}),
    });
    return run._id;
  },
});

export const recentRuns = query({
  args: { automationId: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    if (args.automationId && isDemoId(args.automationId)) return [];
    if (args.automationId) {
      return (await ctx.db
        .query("automationRuns")
        .withIndex("by_automation", (q) => q.eq("automationId", args.automationId!))
        .order("desc")
        .take(DEMO_SCAN_LIMIT))
        .filter((run) => !isDemoAutomationRun(run))
        .slice(0, limit);
    }
    const rows = await ctx.db
      .query("automationRuns")
      .order("desc")
      .take(DEMO_SCAN_LIMIT);
    return rows.filter((run) => !isDemoAutomationRun(run)).slice(0, limit);
  },
});

export const recentRunsForDashboard = query({
  args: { automationId: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const demoOnly = await isDemoModeEnabled(ctx);
    if (args.automationId && isDemoId(args.automationId) !== demoOnly) return [];
    const rows = args.automationId
      ? await ctx.db
          .query("automationRuns")
          .withIndex("by_automation", (q) => q.eq("automationId", args.automationId!))
          .order("desc")
          .take(DEMO_SCAN_LIMIT)
      : await ctx.db.query("automationRuns").order("desc").take(DEMO_SCAN_LIMIT);
    return rows.filter((run) => isDemoAutomationRun(run) === demoOnly).slice(0, limit);
  },
});
