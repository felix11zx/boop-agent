import { env, mutation } from "./_generated/server";
import { v } from "convex/values";

const MAX_BATCH_SIZE = 25;
const MIN_LEASE_MS = 30_000;
const MAX_LEASE_MS = 30 * 60_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;

const inboxMessageValidator = v.object({
  handle: v.string(),
  payload: v.string(),
  attempts: v.number(),
  leaseToken: v.string(),
});

const transitionValidator = v.object({
  applied: v.boolean(),
  state: v.union(
    v.literal("processing"),
    v.literal("pending"),
    v.literal("completed"),
    v.literal("dead_letter"),
    v.literal("stale"),
  ),
});

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.floor(value), minimum), maximum);
}

function requireCapability(received: string): void {
  const expected = env.SENDBLUE_INBOX_CAPABILITY;
  if (!expected) {
    throw new Error("SENDBLUE_INBOX_CAPABILITY is not configured in Convex");
  }
  if (received !== expected) {
    throw new Error("Sendblue inbox capability mismatch");
  }
}

/**
 * Durably records a signed Sendblue callback. A capability mismatch is an
 * error, not a harmless duplicate: a forged row must never silently swallow
 * the legitimate callback with the same provider handle.
 */
export const enqueue = mutation({
  args: {
    handle: v.string(),
    payload: v.string(),
    payloadDigest: v.string(),
    capability: v.string(),
  },
  returns: v.object({ queued: v.boolean() }),
  handler: async (ctx, args) => {
    requireCapability(args.capability);
    const existing = await ctx.db
      .query("sendblueDedup")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .unique();
    if (existing) {
      // Old claim-only rows predate the durable inbox and were already
      // dispatched. Completed/dead rows are also terminal.
      if (
        existing.status === undefined ||
        existing.status === "completed" ||
        existing.status === "dead_letter"
      ) {
        return { queued: false };
      }
      if (existing.capability !== args.capability) {
        throw new Error("Sendblue inbox capability mismatch");
      }
      if (
        existing.payloadDigest !== undefined &&
        existing.payloadDigest !== args.payloadDigest
      ) {
        throw new Error("Sendblue inbox payload conflict");
      }
      // Repair only pre-digest pending rows. Never replace ciphertext under
      // a currently leased worker.
      if (existing.status === "pending" && existing.payloadDigest === undefined) {
        await ctx.db.patch(existing._id, {
          payload: args.payload,
          payloadDigest: args.payloadDigest,
        });
      }
      return { queued: true };
    }

    const now = Date.now();
    await ctx.db.insert("sendblueDedup", {
      handle: args.handle,
      claimedAt: now,
      status: "pending",
      capability: args.capability,
      payload: args.payload,
      payloadDigest: args.payloadDigest,
      attempts: 0,
      nextAttemptAt: now,
    });
    return { queued: true };
  },
});

/** Atomically leases due work and fences every later transition by token. */
export const leasePending = mutation({
  args: {
    capability: v.string(),
    leaseToken: v.string(),
    leaseDurationMs: v.number(),
    limit: v.number(),
    maxAttempts: v.number(),
  },
  returns: v.array(inboxMessageValidator),
  handler: async (ctx, args) => {
    requireCapability(args.capability);
    const now = Date.now();
    const limit = clampInteger(args.limit, 1, MAX_BATCH_SIZE);
    const maxAttempts = clampInteger(args.maxAttempts, 1, 100);
    const leaseExpiresAt =
      now + clampInteger(args.leaseDurationMs, MIN_LEASE_MS, MAX_LEASE_MS);

    const pending = await ctx.db
      .query("sendblueDedup")
      .withIndex("by_capability_and_status_and_next_attempt_at", (q) =>
        q
          .eq("capability", args.capability)
          .eq("status", "pending")
          .lte("nextAttemptAt", now),
      )
      .take(limit);

    const remaining = limit - pending.length;
    const expired =
      remaining > 0
        ? await ctx.db
            .query("sendblueDedup")
            .withIndex("by_capability_and_status_and_lease_expires_at", (q) =>
              q
                .eq("capability", args.capability)
                .eq("status", "processing")
                .lte("leaseExpiresAt", now),
            )
            .take(remaining)
        : [];

    const leased: Array<{
      handle: string;
      payload: string;
      attempts: number;
      leaseToken: string;
    }> = [];
    for (const row of [...pending, ...expired]) {
      const attempts = (row.attempts ?? 0) + 1;
      if (attempts > maxAttempts || row.payload === undefined) {
        await ctx.db.patch(row._id, {
          status: "dead_letter",
          attempts,
          deadLetteredAt: now,
          deadLetterReason:
            row.payload === undefined ? "missing_encrypted_payload" : "max_attempts_exceeded",
          leaseToken: undefined,
          leaseExpiresAt: undefined,
        });
        continue;
      }
      await ctx.db.patch(row._id, {
        status: "processing",
        attempts,
        leaseToken: args.leaseToken,
        leaseExpiresAt,
      });
      leased.push({
        handle: row.handle,
        payload: row.payload,
        attempts,
        leaseToken: args.leaseToken,
      });
    }
    return leased;
  },
});

export const renewLease = mutation({
  args: {
    handle: v.string(),
    capability: v.string(),
    leaseToken: v.string(),
    leaseDurationMs: v.number(),
  },
  returns: transitionValidator,
  handler: async (ctx, args) => {
    requireCapability(args.capability);
    const row = await ctx.db
      .query("sendblueDedup")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .unique();
    if (
      !row ||
      row.capability !== args.capability ||
      row.status !== "processing" ||
      row.leaseToken !== args.leaseToken
    ) {
      return { applied: false, state: "stale" as const };
    }
    await ctx.db.patch(row._id, {
      leaseExpiresAt:
        Date.now() + clampInteger(args.leaseDurationMs, MIN_LEASE_MS, MAX_LEASE_MS),
    });
    return { applied: true, state: "processing" as const };
  },
});

export const markCompleted = mutation({
  args: {
    handle: v.string(),
    capability: v.string(),
    leaseToken: v.string(),
    completedAt: v.number(),
  },
  returns: transitionValidator,
  handler: async (ctx, args) => {
    requireCapability(args.capability);
    const row = await ctx.db
      .query("sendblueDedup")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .unique();
    if (
      !row ||
      row.capability !== args.capability ||
      row.status !== "processing" ||
      row.leaseToken !== args.leaseToken
    ) {
      return { applied: false, state: "stale" as const };
    }
    await ctx.db.patch(row._id, {
      status: "completed",
      completedAt: args.completedAt,
      lastError: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      nextAttemptAt: undefined,
    });
    return { applied: true, state: "completed" as const };
  },
});

export const scheduleRetry = mutation({
  args: {
    handle: v.string(),
    capability: v.string(),
    leaseToken: v.string(),
    delayMs: v.number(),
    error: v.string(),
    maxAttempts: v.number(),
  },
  returns: transitionValidator,
  handler: async (ctx, args) => {
    requireCapability(args.capability);
    const row = await ctx.db
      .query("sendblueDedup")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .unique();
    if (
      !row ||
      row.capability !== args.capability ||
      row.status !== "processing" ||
      row.leaseToken !== args.leaseToken
    ) {
      return { applied: false, state: "stale" as const };
    }
    const now = Date.now();
    const attempts = row.attempts ?? 0;
    if (attempts >= clampInteger(args.maxAttempts, 1, 100)) {
      await ctx.db.patch(row._id, {
        status: "dead_letter",
        lastError: args.error,
        deadLetteredAt: now,
        deadLetterReason: "max_attempts_exceeded",
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      });
      return { applied: true, state: "dead_letter" as const };
    }
    await ctx.db.patch(row._id, {
      status: "pending",
      nextAttemptAt: now + clampInteger(args.delayMs, 0, MAX_RETRY_DELAY_MS),
      lastError: args.error,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    });
    return { applied: true, state: "pending" as const };
  },
});

export const markDeadLetter = mutation({
  args: {
    handle: v.string(),
    capability: v.string(),
    leaseToken: v.string(),
    reason: v.string(),
    error: v.string(),
  },
  returns: transitionValidator,
  handler: async (ctx, args) => {
    requireCapability(args.capability);
    const row = await ctx.db
      .query("sendblueDedup")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .unique();
    if (
      !row ||
      row.capability !== args.capability ||
      row.status !== "processing" ||
      row.leaseToken !== args.leaseToken
    ) {
      return { applied: false, state: "stale" as const };
    }
    await ctx.db.patch(row._id, {
      status: "dead_letter",
      lastError: args.error,
      deadLetteredAt: Date.now(),
      deadLetterReason: args.reason,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    });
    return { applied: true, state: "dead_letter" as const };
  },
});
