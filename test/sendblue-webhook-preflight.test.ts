import { describe, expect, it, vi } from "vitest";
import {
  preflightSendblueWebhook,
  type SendblueWebhookLogger,
  type SendblueWebhookRequestLike,
  type SendblueWebhookResponseLike,
} from "../server/sendblue-webhook-preflight.js";

function request(
  body: unknown,
  headers: Record<string, string> = {},
): SendblueWebhookRequestLike {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    body,
    get: (name) => normalized.get(name.toLowerCase()),
  };
}

function response() {
  const state: { status: number; body?: unknown } = { status: 200 };
  const res: SendblueWebhookResponseLike = {
    status(code) {
      state.status = code;
      return res;
    },
    json(body) {
      state.body = body;
      return res;
    },
  };
  return { res, state };
}

function logger(): SendblueWebhookLogger & {
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function allLogText(log: SendblueWebhookLogger): string {
  const mocked = log as ReturnType<typeof logger>;
  return [mocked.log, mocked.warn, mocked.error]
    .flatMap((fn) => fn.mock.calls)
    .flat()
    .join("\n");
}

const inbound = {
  content: "PRIVATE MESSAGE CONTENT",
  from_number: "+15550000123",
  is_outbound: false,
  message_handle: "PRIVATE-HANDLE-123",
  status: "RECEIVED",
};

describe("Sendblue webhook preflight", () => {
  it("logs header presence without exposing payload or secret values", async () => {
    const { res, state } = response();
    const log = logger();
    const enqueueMessage = vi.fn(async () => ({ queued: true }));

    const result = await preflightSendblueWebhook(
      request(inbound, {
        "content-type": "application/json; charset=utf-8",
        "x-webhook-secret": "PRIVATE-ALTERNATE-SECRET",
      }),
      res,
      {
        enqueueMessage,
        createRequestId: () => "request-401",
        logger: log,
        verifySecret: () => false,
      },
    );

    expect(result).toBeNull();
    expect(state.status).toBe(401);
    expect(state.body).toEqual({
      error: "invalid webhook signature",
      requestId: "request-401",
    });
    expect(enqueueMessage).not.toHaveBeenCalled();
    const text = allLogText(log);
    expect(text).toContain("canonicalSecret=absent alternateSecret=present");
    expect(text).not.toContain("PRIVATE MESSAGE CONTENT");
    expect(text).not.toContain("+15550000123");
    expect(text).not.toContain("PRIVATE-HANDLE-123");
    expect(text).not.toContain("PRIVATE-ALTERNATE-SECRET");
  });

  it("records why an authenticated callback was skipped", async () => {
    const { res, state } = response();
    const log = logger();
    const enqueueMessage = vi.fn(async () => ({ queued: true }));

    const result = await preflightSendblueWebhook(
      request({ ...inbound, is_outbound: true }, { "sb-signing-secret": "correct" }),
      res,
      {
        enqueueMessage,
        createRequestId: () => "request-skip",
        logger: log,
        verifySecret: (secret) => secret === "correct",
      },
    );

    expect(result).toBeNull();
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ ok: true, skipped: true, reason: "outbound" });
    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(allLogText(log)).toContain("skipped reason=outbound status=RECEIVED");
  });

  it("returns a retryable 503 and logs safe error codes when Convex claim fails", async () => {
    const { res, state } = response();
    const log = logger();
    const failure = Object.assign(new TypeError("PRIVATE transport details"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
      cause: { code: "ETIMEDOUT" },
    });

    const result = await preflightSendblueWebhook(
      request(inbound, { "sb-signing-secret": "correct" }),
      res,
      {
        enqueueMessage: vi.fn(async () => {
          throw failure;
        }),
        createRequestId: () => "request-503",
        logger: log,
        verifySecret: () => true,
      },
    );

    expect(result).toBeNull();
    expect(state.status).toBe(503);
    expect(state.body).toEqual({
      error: "temporary webhook processing failure",
      requestId: "request-503",
    });
    const text = allLogText(log);
    expect(text).toContain("inbox_enqueue=failed");
    expect(text).toContain("UND_ERR_CONNECT_TIMEOUT");
    expect(text).toContain("ETIMEDOUT");
    expect(text).not.toContain("PRIVATE transport details");
    expect(text).not.toContain("PRIVATE-HANDLE-123");
  });

  it("acknowledges a duplicate without dispatching it again", async () => {
    const { res, state } = response();
    const log = logger();

    const result = await preflightSendblueWebhook(
      request(inbound, { "sb-signing-secret": "correct" }),
      res,
      {
        enqueueMessage: vi.fn(async () => ({ queued: false })),
        createRequestId: () => "request-dupe",
        logger: log,
        verifySecret: () => true,
      },
    );

    expect(result).toBeNull();
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ ok: true, deduped: true, requestId: "request-dupe" });
    expect(allLogText(log)).toContain("inbox_enqueue=completed");
  });

  it("returns normalized data after a successful claim without logging private fields", async () => {
    const { res, state } = response();
    const log = logger();
    const enqueueMessage = vi.fn(async () => ({ queued: true }));

    const result = await preflightSendblueWebhook(
      request(
        { ...inbound, is_outbound: "false", media_urls: ["https://example.test/image.png"] },
        { "sb-signing-secret": "correct" },
      ),
      res,
      {
        enqueueMessage,
        createRequestId: () => "request-ok",
        logger: log,
        verifySecret: () => true,
      },
    );

    expect(result).toEqual({
      requestId: "request-ok",
      content: "PRIVATE MESSAGE CONTENT",
      fromNumber: "+15550000123",
      messageHandle: "PRIVATE-HANDLE-123",
      rawUrls: ["https://example.test/image.png"],
    });
    expect(state.body).toBeUndefined();
    expect(enqueueMessage).toHaveBeenCalledWith({
      handle: "PRIVATE-HANDLE-123",
      content: "PRIVATE MESSAGE CONTENT",
      fromNumber: "+15550000123",
      rawUrls: ["https://example.test/image.png"],
    });
    const text = allLogText(log);
    expect(text).toContain("inbox_enqueue=queued");
    expect(text).toContain("accepted status=RECEIVED handle=present mediaCount=1");
    expect(text).not.toContain("PRIVATE MESSAGE CONTENT");
    expect(text).not.toContain("+15550000123");
    expect(text).not.toContain("PRIVATE-HANDLE-123");
    expect(text).not.toContain("https://example.test/image.png");
  });

  it("does not acknowledge actionable callbacks without a durable provider handle", async () => {
    const { res, state } = response();
    const log = logger();
    const enqueueMessage = vi.fn(async () => ({ queued: true }));

    const result = await preflightSendblueWebhook(
      request(
        { ...inbound, message_handle: undefined },
        { "sb-signing-secret": "correct" },
      ),
      res,
      {
        enqueueMessage,
        createRequestId: () => "request-no-handle",
        logger: log,
        verifySecret: () => true,
      },
    );

    expect(result).toBeNull();
    expect(state.status).toBe(503);
    expect(state.body).toEqual({
      error: "provider message handle is required",
      requestId: "request-no-h",
    });
    expect(enqueueMessage).not.toHaveBeenCalled();
  });
});
