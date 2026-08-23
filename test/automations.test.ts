import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";
import {
  automationExecutionTask,
  automationNotification,
} from "../server/automations.js";

const modules = import.meta.glob("../convex/**/*.*s");

describe("automation run claiming", () => {
  it("atomically allows only one worker to claim a due occurrence", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.automations.create, {
      automationId: "auto-morning",
      name: "Morning overview",
      task: "Summarize today's calendar.",
      integrations: ["calendar"],
      schedule: "0 8 * * *",
      nextRunAt: 1_000,
    });

    const claims = await Promise.all([
      t.mutation(api.automations.claimDueRun, {
        automationId: "auto-morning",
        runId: "run-a",
        claimedAt: 1_000,
        nextRunAt: 86_401_000,
      }),
      t.mutation(api.automations.claimDueRun, {
        automationId: "auto-morning",
        runId: "run-b",
        claimedAt: 1_000,
        nextRunAt: 86_401_000,
      }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    const runs = await t.run(async (ctx) =>
      ctx.db.query("automationRuns").collect(),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      automationId: "auto-morning",
      status: "running",
      startedAt: 1_000,
    });
  });
});

describe("automation messaging", () => {
  it("tells the worker to execute instead of recreating the schedule", () => {
    const prompt = automationExecutionTask(
      "Morning overview",
      "Every morning, summarize my day.",
    );
    expect(prompt).toContain("is already configured and has fired now");
    expect(prompt).toContain("Do not create, schedule, suggest, or explain another automation");
  });

  it("never exposes a raw runtime abort to the user", () => {
    const notification = automationNotification("Morning overview", {
      status: "cancelled",
      result: "Error: Codex runtime aborted",
    });
    expect(notification).not.toContain("Codex runtime aborted");
    expect(notification).toContain("try again at the next scheduled time");
  });

  it("passes through a completed overview", () => {
    expect(
      automationNotification("Morning overview", {
        status: "completed",
        result: "You have two meetings today.",
      }),
    ).toBe("[Morning overview]\n\nYou have two meetings today.");
  });
});
