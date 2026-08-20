import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";

const modules = import.meta.glob("../convex/**/*.*s");
const CAPABILITY = "capability-a";
process.env.SENDBLUE_INBOX_CAPABILITY = CAPABILITY;

function message(handle = "inbound-1") {
  return {
    handle,
    payload: `encrypted-${handle}`,
    payloadDigest: `digest-${handle}`,
    capability: CAPABILITY,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Sendblue durable inbox state machine", () => {
  it("deduplicates retried internal writes that reuse the stable transport turn", async () => {
    const t = convexTest(schema, modules);
    const args = {
      conversationId: "sms:test-user",
      role: "user" as const,
      content: "hello",
      turnId: "sendblue:inbound-1",
    };
    const first = await t.mutation(api.messages.send, args);
    const second = await t.mutation(api.messages.send, args);
    expect(second).toBe(first);

    const messages = await t.run(async (ctx) => await ctx.db.query("messages").collect());
    const conversations = await t.run(
      async (ctx) => await ctx.db.query("conversations").collect(),
    );
    expect(messages).toHaveLength(1);
    expect(conversations).toMatchObject([{ messageCount: 1 }]);
  });

  it("deduplicates identical callbacks without replacing their payload", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(api.sendblueDedup.enqueue, message())).toEqual({ queued: true });
    expect(await t.mutation(api.sendblueDedup.enqueue, message())).toEqual({ queued: true });

    const rows = await t.run(async (ctx) => await ctx.db.query("sendblueDedup").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(message());
  });

  it("rejects conflicting payloads and capabilities for an existing handle", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.sendblueDedup.enqueue, message());

    await expect(
      t.mutation(api.sendblueDedup.enqueue, {
        ...message(),
        payload: "different-ciphertext",
        payloadDigest: "different-digest",
      }),
    ).rejects.toThrow("payload conflict");
    await expect(
      t.mutation(api.sendblueDedup.enqueue, {
        ...message(),
        capability: "attacker-capability",
      }),
    ).rejects.toThrow("capability mismatch");
  });

  it("rejects an invalid capability before it can pre-claim a provider handle", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.sendblueDedup.enqueue, {
        ...message("unclaimed-handle"),
        capability: "attacker-capability",
      }),
    ).rejects.toThrow("capability mismatch");
    const rows = await t.run(async (ctx) => await ctx.db.query("sendblueDedup").collect());
    expect(rows).toHaveLength(0);
  });

  it("atomically leases a row to only one concurrent worker", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.sendblueDedup.enqueue, message());
    const lease = (leaseToken: string) =>
      t.mutation(api.sendblueDedup.leasePending, {
        capability: CAPABILITY,
        leaseToken,
        leaseDurationMs: 60_000,
        limit: 1,
        maxAttempts: 6,
      });

    const [first, second] = await Promise.all([lease("worker-a"), lease("worker-b")]);
    expect([...first, ...second]).toHaveLength(1);
    expect(new Set([...first, ...second].map((row) => row.leaseToken)).size).toBe(1);
  });

  it("reclaims expired leases and fences the stale worker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
    const t = convexTest(schema, modules);
    await t.mutation(api.sendblueDedup.enqueue, message());
    const [first] = await t.mutation(api.sendblueDedup.leasePending, {
      capability: CAPABILITY,
      leaseToken: "worker-a",
      leaseDurationMs: 30_000,
      limit: 1,
      maxAttempts: 6,
    });
    expect(first.attempts).toBe(1);

    vi.advanceTimersByTime(30_001);
    const [second] = await t.mutation(api.sendblueDedup.leasePending, {
      capability: CAPABILITY,
      leaseToken: "worker-b",
      leaseDurationMs: 30_000,
      limit: 1,
      maxAttempts: 6,
    });
    expect(second.attempts).toBe(2);

    expect(
      await t.mutation(api.sendblueDedup.markCompleted, {
        handle: first.handle,
        capability: CAPABILITY,
        leaseToken: first.leaseToken,
        completedAt: Date.now(),
      }),
    ).toEqual({ applied: false, state: "stale" });
    expect(
      await t.mutation(api.sendblueDedup.markCompleted, {
        handle: second.handle,
        capability: CAPABILITY,
        leaseToken: second.leaseToken,
        completedAt: Date.now(),
      }),
    ).toEqual({ applied: true, state: "completed" });
  });

  it("moves poison work to dead letter after the configured attempt limit", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.sendblueDedup.enqueue, message());
    const [leased] = await t.mutation(api.sendblueDedup.leasePending, {
      capability: CAPABILITY,
      leaseToken: "worker-a",
      leaseDurationMs: 60_000,
      limit: 1,
      maxAttempts: 1,
    });
    expect(
      await t.mutation(api.sendblueDedup.scheduleRetry, {
        handle: leased.handle,
        capability: CAPABILITY,
        leaseToken: leased.leaseToken,
        delayMs: 0,
        error: "permanent poison",
        maxAttempts: 1,
      }),
    ).toEqual({ applied: true, state: "dead_letter" });

    const [row] = await t.run(async (ctx) => await ctx.db.query("sendblueDedup").collect());
    expect(row).toMatchObject({
      status: "dead_letter",
      attempts: 1,
      deadLetterReason: "max_attempts_exceeded",
    });
  });
});
