import { describe, expect, it, vi } from "vitest";
import {
  syncWebhooks,
  webhookCheck,
} from "../scripts/sendblue-webhook.mjs";

describe("Sendblue webhook synchronization", () => {
  it("keeps duplicate active hooks while removing stale tunnel URLs", async () => {
    const active = "https://active.ngrok-free.app/sendblue/webhook";
    const stale = "https://stale.ngrok-free.app/sendblue/webhook";
    const removeWebhook = vi.fn(async () => undefined);
    const addWebhook = vi.fn(async () => undefined);

    await syncWebhooks(
      active,
      [
        { type: "receive", url: active },
        { type: "receive", url: active },
        { type: "receive", url: stale },
      ],
      removeWebhook,
      addWebhook,
    );

    expect(removeWebhook).toHaveBeenCalledOnce();
    expect(removeWebhook).toHaveBeenCalledWith(stale);
    expect(addWebhook).not.toHaveBeenCalled();
  });

  it("registers the active hook when it is missing", async () => {
    const active = "https://active.ngrok-free.app/sendblue/webhook";
    const addWebhook = vi.fn(async () => undefined);

    await syncWebhooks(active, [], vi.fn(async () => undefined), addWebhook);

    expect(addWebhook).toHaveBeenCalledOnce();
    expect(addWebhook).toHaveBeenCalledWith(active);
  });

  it("exclusive mode removes old static receive URLs but keeps other event types", async () => {
    const active = "https://active.ngrok-free.dev/sendblue/webhook";
    const tailscale = "https://boop.example.ts.net/sendblue/webhook";
    const stale = "https://stale.ngrok-free.app/sendblue/webhook";
    const removeWebhook = vi.fn(async () => undefined);
    const addWebhook = vi.fn(async () => undefined);

    await syncWebhooks(
      active,
      [
        { type: "receive", url: active },
        { type: "receive", url: tailscale },
        { type: "receive", url: stale },
        { type: "outbound", url: "https://events.example.test/outbound" },
      ],
      removeWebhook,
      addWebhook,
      { exclusive: true },
    );

    expect(removeWebhook).toHaveBeenCalledTimes(2);
    expect(removeWebhook).toHaveBeenCalledWith(tailscale);
    expect(removeWebhook).toHaveBeenCalledWith(stale);
    expect(addWebhook).not.toHaveBeenCalled();
  });

  it("registers the replacement before deleting old receive hooks", async () => {
    const calls: string[] = [];
    const active = "https://active.ngrok-free.dev/sendblue/webhook";
    const old = "https://boop.example.ts.net/sendblue/webhook";

    await syncWebhooks(
      active,
      [{ type: "receive", url: old }],
      async (url) => {
        calls.push(`remove:${url}`);
      },
      async (url) => {
        calls.push(`add:${url}`);
      },
      { exclusive: true },
    );

    expect(calls).toEqual([`add:${active}`, `remove:${old}`]);
  });

  it("fails exclusive verification while another receive URL remains", () => {
    const active = "https://active.ngrok-free.dev/sendblue/webhook";
    const result = webhookCheck(
      active,
      [
        { type: "receive", url: active },
        { type: "receive", url: "https://boop.example.ts.net/sendblue/webhook" },
      ],
      "api",
      true,
      "",
      { exclusive: true },
    );

    expect(result.ok).toBe(false);
    expect(result.state).toBe("mismatch");
    expect(result.otherReceiveWebhooks).toHaveLength(1);
  });
});
